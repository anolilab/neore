/**
 * Retention for per-user activity records nothing needs forever, run by the
 * shard housekeeping sweep (`lib/shard-housekeeping.ts`) over the shard it
 * serves. Documented in `gdpr/README.md` ("Activity retention").
 *
 * - `usageDaily` — the usage page's per-day rollup. Kept {@link USAGE_DAILY_RETENTION_DAYS}
 *   days: a year of history plus a month, so "this month last year" still reads.
 * - `subAgentRuns` — a delegation's task text and answer. The answer was posted
 *   into the parent thread when the run finished, so the finished run row is
 *   bookkeeping; kept {@link SUB_AGENT_RUN_RETENTION_DAYS} days. Runs still
 *   queued or running are never pruned here (the reaper ends them).
 *
 * Each call deletes at most {@link RETENTION_BATCH} rows per table; the next
 * sweep continues.
 *
 * A dormant shard gets no housekeeping visit, so its rows past their window are pruned when the shard's
 * census due time comes round: each prune notes the expiry of the oldest row left (`noteShardDue`), and the
 * shard tick (`runShardTick`) runs the prune then. Each row then waits for its own expiry, not a daily visit.
 */
import { LunoraError, v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { noteShardDue, setRetentionDue } from "../lib/shard-housekeeping";
import { pruneSubAgentRunsBefore } from "../sub-agents/gdpr";
import { pruneOrganizationRepliesBefore, pruneUsageDaysBefore } from "../usage/gdpr";

export const USAGE_DAILY_RETENTION_DAYS = 400;
export const SUB_AGENT_RUN_RETENTION_DAYS = 90;
export const RETENTION_BATCH = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The soonest a shard is woken again for retained rows, so a batch that left expired rows is finished a minute later. */
const RETENTION_WAKE_FLOOR_MS = 60 * 1000;

/** Pure: the oldest `usageDaily.date` (YYYY-MM-DD, compared as a string) still kept at `now`. */
export const usageDailyCutoffDate = (now: number): string => new Date(now - USAGE_DAILY_RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);

/**
 * Pure: when the oldest retained rows of a shard expire, the earliest of the two. A ledger row is pruned once `at < now - window`; a day
 * row once its date is before {@link usageDailyCutoffDate}, which first holds from the day after it, plus the window. `undefined` when
 * the shard holds neither.
 */
export const retentionExpiryOf = (oldest: { ledgerAt?: number; usageDate?: string }): number | undefined => {
    const window = USAGE_DAILY_RETENTION_DAYS * DAY_MS;
    const expiries: number[] = [];

    if (oldest.ledgerAt !== undefined) {
        expiries.push(oldest.ledgerAt + window + 1);
    }

    if (oldest.usageDate !== undefined) {
        expiries.push(Date.parse(`${oldest.usageDate}T00:00:00Z`) + DAY_MS + window);
    }

    return expiries.length === 0 ? undefined : Math.min(...expiries);
};

export const pruneRetainedActivity = internalMutation
    .input({})
    .output(v.object({ organizationReplies: v.number(), subAgentRuns: v.number(), usageDaily: v.number() }))
    .mutation(async ({ ctx }) => {
        const { now } = ctx;
        const [usageDaily, organizationReplies, subAgentRuns] = await Promise.all([
            pruneUsageDaysBefore(ctx, usageDailyCutoffDate(now), RETENTION_BATCH),
            // The organization ledger keeps the daily rollup's window (`usage/gdpr.ts`, `pruneOrganizationRepliesBefore`).
            pruneOrganizationRepliesBefore(ctx, now - USAGE_DAILY_RETENTION_DAYS * DAY_MS, RETENTION_BATCH),
            pruneSubAgentRunsBefore(ctx, now - SUB_AGENT_RUN_RETENTION_DAYS * DAY_MS, RETENTION_BATCH),
        ]);

        // The next wake-up for this shard's retained rows: the expiry of the oldest one left. Subagent runs are left out: a pending run is
        // never pruned, so its expiry would never pass.
        // From the primary: a lagging replica that misses a row left would leave the shard with no wake for it.
        const oldestDays = await ctx.db.usageDaily.findMany({ consistency: "primary", limit: 1, orderBy: [{ date: "asc" }] });
        const oldestLedgerRows = await ctx.db.usageOrganizationReplies.findMany({ consistency: "primary", limit: 1, orderBy: [{ at: "asc" }] });
        const [oldestDay] = oldestDays.page;
        const [oldestLedgerRow] = oldestLedgerRows.page;
        const expiresAt = retentionExpiryOf({ ledgerAt: oldestLedgerRow?.at, usageDate: oldestDay?.date });

        // The census: when the tick should prune (`retentionDueAt`, cleared when nothing is left), and the wake for it. If either write fails the
        // prune fails, which rolls back its deletes, so the tick retries it soon and the rows are not left without a wake.
        const timed = await setRetentionDue(ctx, expiresAt);
        const woken = expiresAt === undefined ? true : await noteShardDue(ctx, Math.max(expiresAt, now + RETENTION_WAKE_FLOOR_MS));

        if (!timed || !woken) {
            throw new LunoraError("INTERNAL", "The shard's retention wake could not be written; the prune is retried");
        }

        return { organizationReplies, subAgentRuns, usageDaily };
    });
