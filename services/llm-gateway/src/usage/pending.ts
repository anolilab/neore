/**
 * Durable retry for usage charges a render queue gave up on.
 *
 * A render's charge lives on its KV job state (`usagePending`) and is retried by
 * the queue's redeliveries. When those run out while the backend is still
 * unavailable, the consumer hands the charge to `usage_pending` (D1), and the
 * `*\/5` cron re-sends it until the backend accepts it. Only the report is sent
 * again, never the provider call; the backend dedupes on `requestId`.
 */
import type { AppEnv } from "../env.js";
import type { UsageReport } from "./reporter.js";
import { UsageReporter } from "./reporter.js";

/** Sweeps per charge before it is dropped (about 3.5 days of backoff). */
export const PENDING_USAGE_MAX_ATTEMPTS = 10;
/** Delay before sweep n (1-based) is `BASE * 2^(n-1)`: 5 min, 10 min, 20 min… */
export const PENDING_USAGE_BASE_DELAY_MS = 5 * 60 * 1000;
/** Rows per sweep; each costs at most one report attempt. */
export const PENDING_USAGE_BATCH_SIZE = 10;

interface PendingUsageRow {
    attempts: number;
    payload: string;
    request_id: string;
}

export const deferUsageReport = async (database: D1Database, usage: UsageReport, now = Date.now()): Promise<void> => {
    await database
        .prepare("INSERT OR IGNORE INTO usage_pending (request_id, payload, attempts, next_attempt_at) VALUES (?, ?, 0, ?)")
        .bind(usage.requestId, JSON.stringify(usage), now)
        .run();
};

export const sweepPendingUsage = async (env: AppEnv, now = Date.now()): Promise<void> => {
    const { results } = await env.USAGE_DB.prepare(
        "SELECT request_id, payload, attempts FROM usage_pending WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
    )
        .bind(now, PENDING_USAGE_BATCH_SIZE)
        .all<PendingUsageRow>();

    const reporter = new UsageReporter(env, { maxAttempts: 1 });

    for (const row of results) {
        const attempts = row.attempts + 1;

        if (await reporter.report(JSON.parse(row.payload) as UsageReport)) {
            await env.USAGE_DB.prepare("DELETE FROM usage_pending WHERE request_id = ?").bind(row.request_id).run();
        } else if (attempts >= PENDING_USAGE_MAX_ATTEMPTS) {
            console.error(`[UsagePending] Dropping usage report ${row.request_id} after ${attempts} sweeps — credits not deducted`);
            await env.USAGE_DB.prepare("DELETE FROM usage_pending WHERE request_id = ?").bind(row.request_id).run();
        } else {
            await env.USAGE_DB.prepare("UPDATE usage_pending SET attempts = ?, next_attempt_at = ? WHERE request_id = ?")
                .bind(attempts, now + PENDING_USAGE_BASE_DELAY_MS * 2 ** (attempts - 1), row.request_id)
                .run();
        }
    }
};
