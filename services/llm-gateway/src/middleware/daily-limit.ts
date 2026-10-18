/**
 * Optional per-user DAILY caps on the public chat route (`/v1/chat/completions`,
 * and `/v1/responses` through it), on top of the per-minute limit and the credit
 * balance. Both are off until configured, per tier:
 *
 *   DAILY_REQUEST_LIMITS="free=200,pro=5000"
 *   DAILY_TOKEN_LIMITS="free=100000,pro=5000000"
 *
 * A tier without an entry is uncapped. The day is the UTC day.
 *
 * The count is read from `usage_log`, which every finished call already writes,
 * rather than from a counter of its own: a KV counter takes a write per request
 * to one key, which KV rate-limits (about one write a second per key), so the
 * counter would stall under exactly the burst a cap is for. What it costs is
 * precision: only FINISHED calls are counted (`source = 'saas_api'`, so embeddings
 * and media calls made with the same key count too), requests still in flight
 * are not, and a call can run the token cap over because it is checked before the
 * call. That is enough to stop a runaway key; credits remain the billing boundary.
 * A failed read lets the request through.
 */
import { createMiddleware } from "hono/factory";

import type { HonoEnv } from "../env.js";

type TierLimits = Readonly<Record<string, number>>;

/** `"free=200,pro=5000"` → `{ free: 200, pro: 5000 }`. Entries that are not a tier and a positive integer are ignored. */
export const parseTierLimits = (raw: string | undefined): TierLimits => {
    const limits: Record<string, number> = {};
    const pairs = raw?.split(",") ?? [];

    for (const pair of pairs) {
        const [tier, value] = pair.split("=").map((part) => part.trim());
        const limit = Number(value);

        if (tier && Number.isSafeInteger(limit) && limit > 0) {
            limits[tier] = limit;
        }
    }

    return limits;
};

export const secondsUntilUtcMidnight = (now: number = Date.now()): number => {
    const next = new Date(now);

    next.setUTCHours(24, 0, 0, 0);

    return Math.ceil((next.getTime() - now) / 1000);
};

/** `usage_log.created_at` is SQLite's `datetime('now')`: UTC, `YYYY-MM-DD HH:MM:SS`. */
const startOfUtcDay = (now: number): string => `${new Date(now).toISOString().slice(0, 10)} 00:00:00`;

export interface DailyUsage {
    requests: number;
    tokens: number;
}

export const readDailyUsage = async (db: D1Database, userId: string, now: number = Date.now()): Promise<DailyUsage> => {
    const row = await db
        .prepare(
            `SELECT COUNT(*) AS requests, COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
             FROM usage_log WHERE user_id = ? AND source = 'saas_api' AND created_at >= ?`,
        )
        .bind(userId, startOfUtcDay(now))
        .first<{ requests: number; tokens: number }>();

    return { requests: Number(row?.requests ?? 0), tokens: Number(row?.tokens ?? 0) };
};

const refuse = (message: string) => {
    const retryAfter = secondsUntilUtcMidnight();

    return Response.json({ error: { code: "DAILY_LIMIT_EXCEEDED", message, retryAfter } }, { headers: { "Retry-After": String(retryAfter) }, status: 429 });
};

/** Runs after `bearerAuth` (needs `userId` and `userTier`). */
export const dailyLimitMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
    const userId = c.get("userId");
    const tier = c.get("userTier") ?? "free";
    const requestLimit = parseTierLimits(c.env.DAILY_REQUEST_LIMITS)[tier];
    const tokenLimit = parseTierLimits(c.env.DAILY_TOKEN_LIMITS)[tier];

    if (!userId || (requestLimit === undefined && tokenLimit === undefined)) {
        await next();

        return undefined;
    }

    let usage: DailyUsage | undefined;

    try {
        usage = await readDailyUsage(c.env.USAGE_DB, userId);
    } catch {
        // A read that fails must not refuse a request that may be within its limit.
    }

    if (usage && requestLimit !== undefined && usage.requests >= requestLimit) {
        return refuse(`Daily request limit reached: ${requestLimit} requests per day on the ${tier} tier. It resets at 00:00 UTC.`);
    }

    if (usage && tokenLimit !== undefined && usage.tokens >= tokenLimit) {
        return refuse(`Daily token limit reached: ${tokenLimit} tokens per day on the ${tier} tier. It resets at 00:00 UTC.`);
    }

    await next();

    return undefined;
});
