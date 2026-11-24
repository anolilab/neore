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
 * shard tick (`runShardTick`) runs the prune then. A ledger row waits for the first UTC midnight past its
 * window, so a day of replies is one wake, not one per reply.
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
 * Pure: when the oldest retained rows of a shard expire, the earliest of the two. A ledger row is pruned once `at < now - window`, and its
 * expiry is the first UTC midnight past that, so every reply of one day shares one wake rather than waking the shard once per reply; a row
 * is kept at most a day past its window. A day row expires once its date is before {@link usageDailyCutoffDate}, which first holds from
 * the day after it, plus the window. `undefined` when the shard holds neither.
 */
export const retentionExpiryOf = (oldest: { ledgerAt?: number; usageDate?: string }): number | undefined => {
    const window = USAGE_DAILY_RETENTION_DAYS * DAY_MS;
    const expiries: number[] = [];

    if (oldest.ledgerAt !== undefined) {
        expiries.push((Math.floor((oldest.ledgerAt + window) / DAY_MS) + 1) * DAY_MS);
    }

    if (oldest.usageDate !== undefined) {
        expiries.push(Date.parse(`${oldest.usageDate}T00:00:00Z`) + DAY_MS + window);
    }

    return expiries.length === 0 ? undefined : Math.min(...expiries);
};

/**
 * Pure: when a shard is next due after a prune, given its oldest rows left. A ledger row the batch left past its window (the batch was
 * full) is due now, not at the midnight {@link retentionExpiryOf} rounds it up to, so the rest is taken a minute later.
 */
export const retentionDueAfterPrune = (now: number, oldest: { ledgerAt?: number; usageDate?: string }): number | undefined =>
    oldest.ledgerAt !== undefined && oldest.ledgerAt < now - USAGE_DAILY_RETENTION_DAYS * DAY_MS ? now : retentionExpiryOf(oldest);

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
        const expiresAt = retentionDueAfterPrune(now, { ledgerAt: oldestLedgerRow?.at, usageDate: oldestDay?.date });

        // The census: when the tick should prune (`retentionDueAt`, cleared when nothing is left), and the wake for it. If either write fails the
        // prune fails, which rolls back its deletes, so the tick retries it soon and the rows are not left without a wake.
        const timed = await setRetentionDue(ctx, expiresAt);
        const woken = expiresAt === undefined ? true : await noteShardDue(ctx, Math.max(expiresAt, now + RETENTION_WAKE_FLOOR_MS));

        if (!timed || !woken) {
            // The throw rolls back this shard's deletes, but the census is global and keeps any write that landed: a later expiry there would
            // skip the restored rows. So the census points at now, and the retry prunes them.
            await setRetentionDue(ctx, now);

            throw new LunoraError("INTERNAL", "The shard's retention wake could not be written; the prune is retried");
        }

        return { organizationReplies, subAgentRuns, usageDaily };
    });
