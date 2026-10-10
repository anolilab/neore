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
 */
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { pruneSubAgentRunsBefore } from "../sub-agents/gdpr";
import { pruneUsageDaysBefore } from "../usage/gdpr";

export const USAGE_DAILY_RETENTION_DAYS = 400;
export const SUB_AGENT_RUN_RETENTION_DAYS = 90;
export const RETENTION_BATCH = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pure: the oldest `usageDaily.date` (YYYY-MM-DD, compared as a string) still kept at `now`. */
export const usageDailyCutoffDate = (now: number): string => new Date(now - USAGE_DAILY_RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);

export const pruneRetainedActivity = internalMutation
    .input({})
    .output(v.object({ subAgentRuns: v.number(), usageDaily: v.number() }))
    .mutation(async ({ ctx }) => {
        const now = ctx.now;
        const [usageDaily, subAgentRuns] = await Promise.all([
            pruneUsageDaysBefore(ctx, usageDailyCutoffDate(now), RETENTION_BATCH),
            pruneSubAgentRunsBefore(ctx, now - SUB_AGENT_RUN_RETENTION_DAYS * DAY_MS, RETENTION_BATCH),
        ]);

        return { subAgentRuns, usageDaily };
    });
