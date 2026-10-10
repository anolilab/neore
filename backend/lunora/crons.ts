import type { FunctionReference } from "lunorash/client";
import { cronJobs } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "./_generated/internal";
import type { ActionCtx } from "./_generated/server";
import { internalAction, internalMutation } from "./_generated/server";
import type { PeriodicJob } from "./lib/cron-schedule";
import { dueJobs } from "./lib/cron-schedule";
import { HISTORY_PAGE } from "./lib/document-history";
import { cronsLogger } from "./lib/logger";
import { scheduleObjectDeletion } from "./lib/storage-cleanup";

export const crons = cronJobs();

const THRESHOLD_MS = 1000 * 60 * 60 * 24;

// Keep-alive to prevent cold starts - runs every 10 minutes
export const keepAlive = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx: context }) => {
        // Simple read to keep the backend warm
        // Query a table that exists in the main schema
        await context.db.query("files").first();

        return null;
    });

export const deleteUnusedFiles = internalMutation
    .input({ cursor: v.optional(v.string()) })
    .output(v.null())
    .mutation(async ({ args: arguments_, ctx: context }) => {
        const files = await context.runQuery(internal.agent.files.getFilesToDelete, {
            paginationOpts: {
                cursor: arguments_.cursor ?? null,
                numItems: 100,
            },
        });
        const toDelete = files.page.filter((f) => f.lastTouchedAt < context.now - THRESHOLD_MS);

        if (toDelete.length > 0) {
            cronsLogger.debug(`Deleting ${toDelete.length} files...`);
        }

        await scheduleObjectDeletion(
            context,
            toDelete.map((f) => f.storageId as string),
        );
        await context.runMutation(internal.agent.files.deleteFiles, {
            fileIds: toDelete.map((f) => f._id),
        });

        if (!files.isDone) {
            cronsLogger.debug(`Deleted ${toDelete.length} files but not done yet, continuing...`);
            await context.scheduler.runAfter(0, internal.crons.deleteUnusedFiles, {
                // Lunora's paginate returns `null` once exhausted; the recursive arg
                // is `v.optional(v.string())`.
                cursor: files.continueCursor ?? undefined,
            });
        }

        return null;
    });

// Reclaim expired `actionCache` rows.
//
// Expiry is lazy by design: a read past `expiresAt` reports a miss and leaves
// the row, which keeps reads in a query with no write. That means nothing
// reclaims the space unless this runs — and the heaviest writers are LLM
// responses, so the table grows without bound otherwise.
//
// `purgeExpired` deletes one bounded batch and reports how many it took, so this
// keeps calling it until a round comes back empty. A single batch per hour is not
// a sweep: the heaviest writers here are LLM responses, and any hour that expires
// more rows than one batch holds leaves the table permanently ahead of the purge.
//
// ponytail: capped at PURGE_ROUNDS_PER_RUN rounds so one cron tick cannot run
// unbounded; the next tick continues where this one stopped.
const PURGE_ROUNDS_PER_RUN = 20;

export const purgeActionCache = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx: context }) => {
        let deleted = 0;

        for (let round = 0; round < PURGE_ROUNDS_PER_RUN; round += 1) {
            const batch = await context.runMutation(internal.lib.action_cache.purgeExpired, {});

            deleted += batch;

            if (batch === 0) {
                break;
            }
        }

        if (deleted > 0) {
            cronsLogger.debug(`Purged ${String(deleted)} expired action-cache row(s)`);
        }

        return null;
    });

/**
 * Retention for `documentHistory`.
 *
 * `vacuumHistory` has existed since the port and nothing ever called it — no
 * cron did either, checked against the tree before
 * it was deleted. That was survivable there only because the audit triggers were
 * DEAD: nothing imported `auditTriggers.ts`, so the sole writers were eight
 * explicit `recordHistory` calls for `threads`.
 *
 * Wiring the triggers onto all 19 tables in `AUDIT_TABLES` fixed the GDPR gap
 * (`listUserActivity` was returning a fraction of a user's activity) and, in the
 * same stroke, turned an effectively-idle table into one that takes a row on
 * every insert, update and delete across the schema. A writer without a reaper
 * is a disk-usage incident on a slow fuse, so the reaper lands with the writer.
 *
 * 90 days matches the retention the component's own README documents.
 */
const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const vacuumDocumentHistory = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx: context }) => {
        const removed = await context.runMutation(internal.lib.document_history.vacuumHistory, {
            minTsToKeep: context.now - HISTORY_RETENTION_MS,
        });

        // `vacuumHistory` deletes at most HISTORY_PAGE per call so one mutation
        // never opens an unbounded transaction. A full batch means there is
        // probably more, so continue rather than waiting a day per 200 rows —
        // on a backlog that would never converge.
        if (removed >= HISTORY_PAGE) {
            cronsLogger.debug(`vacuumDocumentHistory: removed ${removed}, continuing`);
            await context.scheduler.runAfter(0, internal.crons.vacuumDocumentHistory, {});
        } else if (removed > 0) {
            cronsLogger.info(`vacuumDocumentHistory: removed ${removed} expired history rows`);
        }

        return null;
    });

// Batch size for processing temporary threads to avoid timeouts
const TEMPORARY_THREAD_BATCH_SIZE = 50;

export const deleteExpiredTemporaryChats = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx: context }) => {
        // Expired ids straight off the `by_expiresAt` index. This used to read
        // `api.agent.threads.getTemporaryThreadsByThreadIds`, a CLIENT query that
        // answers only for the caller's own threads — and a cron has no caller, so
        // it always answered `{}` and no temporary chat was ever deleted.
        const expiredThreadIds = await context.runQuery(internal.agent.threads.getExpiredTemporaryThreadIds, { now: context.now });

        if (expiredThreadIds.length === 0) {
            cronsLogger.debug("deleteExpiredTemporaryChats: No expired temporary threads found");

            return null;
        }

        cronsLogger.info(`deleteExpiredTemporaryChats: Found ${expiredThreadIds.length} expired temporary threads`);

        // Process only the first batch in this run
        const batch = expiredThreadIds.slice(0, TEMPORARY_THREAD_BATCH_SIZE);
        let deletedCount = 0;

        for (const threadId of batch) {
            try {
                // Delete the thread and all its associated data (messages,
                // streams, and its `temporaryThreads` marker — without which
                // the next run would find the same ids forever).
                await context.runMutation(internal.agent.threads.deleteAllForThreadIdAsync, {
                    threadId,
                });

                deletedCount += 1;
            } catch (error) {
                cronsLogger.error(`deleteExpiredTemporaryChats: Failed to delete thread ${threadId}:`, error);
            }
        }

        cronsLogger.info(`deleteExpiredTemporaryChats: Deleted ${deletedCount} expired temporary threads`);

        // If there are more expired threads, schedule another run
        // This recalculates expired threads fresh each time to handle any changes
        if (expiredThreadIds.length > TEMPORARY_THREAD_BATCH_SIZE) {
            cronsLogger.debug(`deleteExpiredTemporaryChats: More expired threads remain, scheduling follow-up`);
            await context.scheduler.runAfter(100, internal.crons.deleteExpiredTemporaryChats, {});
        }

        return null;
    });

// ─── The one cron trigger ─────────────────────────────────────────────────────
//
// Cloudflare allows at most 3 Cron Triggers per Worker and these jobs used six
// distinct expressions, so a single one-minute tick runs them all: the
// one-minute jobs every tick, the rest when their slot is due
// (`lib/cron-schedule.ts`). Each job keeps the cadence its old expression gave it.

type CronCtx = Pick<ActionCtx, "runMutation">;

/** A job is an argument-less internal mutation; the tick calls `ctx.runMutation(ref, {})`. */
interface CronJob {
    name: string;
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the generated type of an argument-less mutation.
    ref: FunctionReference<"mutation", {}, unknown>;
}

/** Run every tick. */
const EVERY_MINUTE_JOBS: ReadonlyArray<CronJob> = [
    { name: "checkDueTriggers", ref: internal.triggers.schedule.checkDueTriggers },
    { name: "cleanupExpiredPersistentStreams", ref: internal.chat.streaming.persistent.crons.cleanupExpiredStreams },
    // Removes disconnected users' workflow presence.
    { name: "cleanupStaleWorkflowPresence", ref: internal.workflow.presence.cleanupStalePresence },
    // Queue jobs whose delivery died mid-run: fail their pending state (`lib/claim-once.ts`).
    { name: "reapLapsedClaims", ref: internal.lib.claim_once.reapLapsedClaims },
    // Every job above sweeps `__root__` only. The same sweeps on each USER shard,
    // where those rows now live, are fanned out through the `.global()` census
    // (`lib/shard-housekeeping.ts`, docs/plans/per-user-sharding.md).
    { name: "dispatchDueShards", ref: internal.lib.shard_housekeeping.dispatchDueShards },
];

/** Run when due. The schedules reproduce the expressions they replaced (noted per job). */
export const PERIODIC_JOBS: ReadonlyArray<CronJob & PeriodicJob> = [
    // */10 * * * *
    { name: "keepAlive", ref: internal.crons.keepAlive, schedule: { everyMinutes: 10, kind: "interval" } },
    // The per-user cleanup sweeps, on each shard that needs them (`lib/shard-housekeeping.ts`).
    { name: "dispatchShardHousekeeping", ref: internal.lib.shard_housekeeping.dispatchShardHousekeeping, schedule: { everyMinutes: 10, kind: "interval" } },
    // 0 */1 * * *
    {
        name: "deleteUnusedFiles",
        ref: internal.crons.deleteUnusedFiles,
        schedule: { everyMinutes: 60, kind: "interval" },
    },
    {
        name: "purgeActionCache",
        ref: internal.crons.purgeActionCache,
        schedule: { everyMinutes: 60, kind: "interval" },
    },
    {
        name: "deleteExpiredTemporaryChats",
        ref: internal.crons.deleteExpiredTemporaryChats,
        schedule: { everyMinutes: 60, kind: "interval" },
    },
    // Claim-once rows past their TTL (`lib/claim-once.ts`).
    { name: "purgeIdempotencyClaims", ref: internal.lib.claim_once.purgeExpiredClaims, schedule: { everyMinutes: 60, kind: "interval" } },
    // 0 */6 * * *
    {
        name: "cleanupExpiredExports",
        ref: internal.gdpr.request_sweeps.cleanupExpiredExports,
        schedule: { everyMinutes: 360, kind: "interval" },
    },
    // 30 3 * * *
    {
        name: "vacuumDocumentHistory",
        ref: internal.crons.vacuumDocumentHistory,
        schedule: { hourUTC: 3, kind: "daily", minuteUTC: 30 },
    },
    // 0 0 * * *
    {
        // eslint-disable-next-line no-secrets/no-secrets
        name: "handleGdprRequestTimeouts",
        ref: internal.gdpr.request_sweeps.handleGdprRequestTimeouts,
        schedule: { hourUTC: 0, kind: "daily", minuteUTC: 0 },
    },
];

/**
 * Claim every periodic job due at `now` and return their names. A mutation, so
 * two ticks arriving together (a retried or duplicated cron fire) are
 * serialised and the second finds each slot claimed: a job runs at most once
 * per slot. Claimed before it runs, so a job that then fails waits for its next
 * slot — what a failed cron fire did before.
 */
export const claimDueCronJobs = internalMutation
    .input({ now: v.number() })
    .output(v.array(v.string()))
    .mutation(async ({ args: { now }, ctx }) => {
        const rows = await Promise.all(
            PERIODIC_JOBS.map(
                async (job) =>
                    await ctx.db
                        .query("cronRuns")
                        .withIndex("by_name", (q) => q.eq("name", job.name))
                        .first(),
            ),
        );
        const byName = new Map(rows.flatMap((row) => (row ? [[row.name, row] as const] : [])));
        const due = dueJobs(PERIODIC_JOBS, Object.fromEntries([...byName].map(([name, row]) => [name, row.lastSlot])), now);

        for (const { name, slot } of due) {
            const existing = byName.get(name);

            if (existing) {
                await ctx.db.patch(existing._id, { lastRunAt: now, lastSlot: slot });
            } else {
                await ctx.db.insert("cronRuns", { lastRunAt: now, lastSlot: slot, name });
            }
        }

        return due.map((job) => job.name);
    });

/**
 * The tick: every one-minute job, then each periodic job this tick claimed.
 * Jobs run one after another and a failure is logged without stopping the
 * rest, as the runtime did for jobs sharing an expression.
 */
export const runCronTick = async (ctx: CronCtx, now: number): Promise<{ failed: string[]; ran: string[] }> => {
    const ran: string[] = [];
    const failed: string[] = [];
    const run = async (job: CronJob): Promise<void> => {
        try {
            await ctx.runMutation(job.ref, {});
            ran.push(job.name);
        } catch (error) {
            failed.push(job.name);
            cronsLogger.error(`[cron] ${job.name} failed:`, error);
        }
    };

    for (const job of EVERY_MINUTE_JOBS) {
        await run(job);
    }

    const due = await ctx.runMutation(internal.crons.claimDueCronJobs, { now });

    for (const job of PERIODIC_JOBS) {
        if (due.includes(job.name)) {
            await run(job);
        }
    }

    return { failed, ran };
};

export const cronTick = internalAction
    .input({})
    .output(v.null())
    .action(async ({ ctx }) => {
        await runCronTick(ctx, Date.now());

        return null;
    });

crons.interval("tick", { minutes: 1 }, internal.crons.cronTick, {});

// Cron jobs require a default export
export default crons;
