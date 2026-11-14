/**
 * Periodic work on every user's shard, driven from the root cron tick.
 *
 * The cron tick runs on `__root__`, but the tables its sweeps scan — expired
 * temporary chats and streams, stale presence, lapsed claims, due triggers and
 * tasks, GDPR request timeouts — now live on each user's own shard.
 * So the tick FANS OUT: a `.global()` census
 * (`shardActivity`) says which user shards exist and what they need, and the
 * tick schedules the work onto each of them (`shardKey`), where it runs against
 * that shard's rows exactly as it used to run against root's.
 *
 * - **Timed work** (schedule triggers, recurring tasks): each shard keeps
 *   `nextDueAt` in its census row. The one-minute tick dispatches
 *   {@link runShardTick} to every shard that is due; the tick recomputes the
 *   shard's next due time from its own tables.
 * - **Housekeeping** (the cleanup sweeps): every ten minutes the tick dispatches
 *   {@link runShardHousekeeping} to each shard active since its last sweep, and
 *   at least daily to any shard active in the last {@link HOUSEKEEPING_HORIZON_MS}
 *   — an expiry does not wait for its owner to come back.
 * - **Dormant shards** (idle past that horizon): only the `rateLimits` sweep.
 *   The census flag `rateLimitsPending` says a shard may hold rows: activity and
 *   any charge that adds a row set it, and the dormant sweep clears it when it
 *   leaves the table empty. A daily job reads only flagged dormant rows, through
 *   their index, and dispatches `sweepDormantShardRateLimits`
 *   (`lib/rate-limit-sweep.ts`) to each, so a shard that stays dormant and empty
 *   costs nothing.
 *
 * Each dispatch goes on the target user's own scheduler lane
 * (`shard-scheduler.ts`), so shards are swept side by side, not one at a time.
 */
import type { FunctionReference } from "lunorash/client";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { internalAction, internalMutation } from "../_generated/server";
import { enqueueJob } from "./job-queue";
import { cronsLogger } from "./logger";
import { patchRow } from "./patch";
import { currentUserShard } from "./shard-context";
import { runAfterOnShard } from "./shard-scheduler";

/** How long a shard stays in the daily sweep after its last activity. */
export const HOUSEKEEPING_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
/** A swept shard with no new activity is swept again after this long. */
export const HOUSEKEEPING_IDLE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Activity is recorded at most this often per shard per isolate. */
const ACTIVITY_THROTTLE_MS = 10 * 60 * 1000;
/** A shard tick re-arms no sooner than this, so a stuck due row cannot spin. */
const MIN_TICK_INTERVAL_MS = 60 * 1000;

/** Shards dispatched per root run; the rest wait for the next one. */
export const DISPATCH_BATCH = 200;

/** An argument-less internal mutation, as in `crons.ts`. */
interface Sweep {
    name: string;
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the generated type of an argument-less mutation.
    ref: FunctionReference<"mutation", {}, unknown>;
}

/**
 * The sweeps a housekeeping run performs on one shard — the per-user half of
 * `crons.ts`. A function, so the references resolve at use, not at import.
 */
const shardSweeps = (): ReadonlyArray<Sweep> => [
    // Backstop for the minute tick: an event watcher whose shard lost its due row is still visited.
    { name: "dispatchDueEventTriggers", ref: internal.triggers.events.dispatchDueEventTriggers },
    // Same backstop for the watched repositories: a repository whose shard lost its due row is still polled.
    { name: "dispatchDueRepoPolls", ref: internal.source_control.freshness_internal.dispatchDueRepoPolls },
    { name: "cleanupExpiredPersistentStreams", ref: internal.chat.streaming.persistent.crons.cleanupExpiredStreams },
    { name: "purgeFinishedStreams", ref: internal.chat.streaming.persistent.purge.purgeFinishedStreams },
    { name: "failStaleMediaRows", ref: internal.chat.media_stale.failStaleMediaRows },
    { name: "reapStalledGoals", ref: internal.chat.goals.internal.reapStalledGoals },
    // A sub-agent waiting on an approval whose own reaper was lost (`sub-agents/functions.ts`).
    { name: "reapOverdueSubAgentWaits", ref: internal.sub_agents.functions.reapOverdueWaits },
    { name: "cleanupStaleWorkflowPresence", ref: internal.workflow.presence.cleanupStalePresence },
    { name: "reapLapsedClaims", ref: internal.lib.claim_once.reapLapsedClaims },
    { name: "purgeIdempotencyClaims", ref: internal.lib.claim_once.purgeExpiredClaims },
    // Rate-limit rows charged on this shard, past every limit's window (`lib/rate-limit-sweep.ts`).
    { name: "sweepExpiredRateLimits", ref: internal.lib.rate_limit_sweep.sweepExpiredRateLimits },
    { name: "deleteExpiredTemporaryChats", ref: internal.crons.deleteExpiredTemporaryChats },
    // Per-user setting (`autoArchiveAfterDays`); does nothing for users who left it off.
    { name: "autoArchiveInactiveThreads", ref: internal.agent.auto_archive.autoArchiveInactiveThreads },
    { name: "cleanupExpiredExports", ref: internal.gdpr.request_sweeps.cleanupExpiredExports },
    { name: "handleGdprRequestTimeouts", ref: internal.gdpr.request_sweeps.handleGdprRequestTimeouts },
    { name: "pruneOldNotifications", ref: internal.notifications.functions.pruneOldNotifications },
    { name: "dispatchOutcomeEmails", ref: internal.notifications.task_email.dispatchOutcomeEmails },
    { name: "sweepDeviceCalls", ref: internal.devices.internal.sweepDeviceCalls },
    { name: "sweepKnowledgeFiles", ref: internal.knowledge.housekeeping.sweepKnowledgeFiles },
    { name: "pruneRetainedActivity", ref: internal.gdpr.retention.pruneRetainedActivity },
    // An export whose workflow died leaves its pieces and usage object on the shard; past their time to live, the sweep removes them.
    { name: "sweepUsageExportPieces", ref: internal.usage.gdpr.sweepUsageExportPieces },
    { name: "sweepUsageRollup", ref: internal.usage.backfill.sweepUsageRollup },
    { name: "sweepStagedChatUploads", ref: internal.file.sweepStagedChatUploads },
    { name: "pruneExpiredToolPermissionGrants", ref: internal.chat.tool_permissions.pruneExpiredToolPermissionGrants },
    // A run's saved prompt is cleared 28 days after the run settles (`triggers/functions.ts`); the run row stays.
    { name: "pruneExpiredRunPrompts", ref: internal.triggers.functions.pruneExpiredRunPrompts },
    // References the agent was never able to spend within their 24 hours (`chat/request-secret.ts`).
    { name: "sweepRequestedSecrets", ref: internal.chat.request_secret.sweepRequestedSecrets },
    // Guest links past their 24 hours, with what guests left on them (`chat/guest-links.ts`).
    { name: "sweepGuestLinks", ref: internal.chat.guest_links.sweepGuestLinks },
    { name: "backfillUnindexedFileLinks", ref: internal.agent.file_link_backfill.backfillUnindexedFileLinks },
];

type CensusCtx = Pick<MutationCtx, "db">;

/** Pure: which census rows a housekeeping run sweeps now. Pinned by `shard-housekeeping.test.ts`. */
export const needsHousekeeping = (row: { housekeptAt?: number; lastActiveAt: number }, now: number): boolean => {
    if (now - row.lastActiveAt > HOUSEKEEPING_HORIZON_MS) {
        return false;
    }

    return row.housekeptAt === undefined || row.lastActiveAt >= row.housekeptAt || now - row.housekeptAt >= HOUSEKEEPING_IDLE_INTERVAL_MS;
};

/**
 * The census is a HINT for the root tick, written beside the caller's own work
 * (a sign-up, a trigger save) in D1 — not atomically with it. A failed hint must
 * never fail that work; the worst it costs is a late sweep.
 */
const bestEffort = async (what: string, write: () => Promise<void>): Promise<boolean> => {
    try {
        await write();

        return true;
    } catch (error) {
        cronsLogger.warn(`[housekeeping] ${what} failed:`, error);

        return false;
    }
};

const censusRow = async (ctx: CensusCtx, shardKey: string) => await ctx.db.shardActivity.findFirst({ where: { shardKey } });

const touchedAt = new Map<string, number>();

/**
 * Record that `shardKey` (default: the shard this code serves) was active, so
 * housekeeping visits it. Throttled per isolate; a no-op off a user shard.
 */
export const noteShardActivity = async (ctx: CensusCtx, shardKey: string | undefined = currentUserShard(), now = Date.now()): Promise<void> => {
    if (shardKey === undefined || now - (touchedAt.get(shardKey) ?? 0) < ACTIVITY_THROTTLE_MS) {
        return;
    }

    touchedAt.set(shardKey, now);

    await bestEffort("noteShardActivity", async () => {
        const row = await censusRow(ctx, shardKey);

        if (row) {
            await ctx.db.patch("shardActivity", row._id, { lastActiveAt: now, rateLimitsPending: true });
        } else {
            await ctx.db.insert("shardActivity", { lastActiveAt: now, rateLimitsPending: true, shardKey });
        }
    });
};

/**
 * Tell the root tick that `shardKey` (default: this shard) has timed work due
 * at `dueAt`. Keeps the EARLIEST due time; {@link runShardTick} resets it.
 */
export const noteShardDue = async (ctx: CensusCtx, dueAt: number, shardKey: string | undefined = currentUserShard()): Promise<void> => {
    if (shardKey === undefined) {
        return;
    }

    await bestEffort("noteShardDue", async () => {
        const row = await censusRow(ctx, shardKey);

        if (!row) {
            await ctx.db.insert("shardActivity", { lastActiveAt: Date.now(), nextDueAt: dueAt, shardKey });

            return;
        }

        if (row.nextDueAt === undefined || dueAt < row.nextDueAt) {
            await ctx.db.patch("shardActivity", row._id, { nextDueAt: dueAt });
        }
    });
};

/** Before the retry of a failed {@link noteRateLimitsPending} write, so a passing D1 failure has cleared. */
export const RATE_LIMITS_PENDING_RETRY_MS = 30 * 1000;

const markRateLimitsPendingRow = async (ctx: CensusCtx, shardKey: string): Promise<void> => {
    const row = await censusRow(ctx, shardKey);

    if (!row) {
        await ctx.db.insert("shardActivity", { lastActiveAt: Date.now(), rateLimitsPending: true, shardKey });
    } else if (row.rateLimitsPending !== true) {
        await ctx.db.patch("shardActivity", row._id, { rateLimitsPending: true });
    }
};

/**
 * On a user shard: a charge added a `rateLimits` row, so the dormant-shard dispatch must visit this shard. A charge need
 * not move `lastActiveAt` (a guest's post on the owner's shard), so this is its own note. Writes only when the flag is
 * off; a charge that only updates a row needs none, since a table holding a row keeps the flag on
 * ({@link settleRateLimitsPending} re-checks after clearing).
 *
 * The row is already written, and a later charge on that key only updates it, so a failed write would leave the flag off
 * for good: it is retried out of band, by {@link markRateLimitsPending} on this shard through the jobs queue (whose own
 * redelivery bounds it to three tries). Neither the write nor the send ever fails the charge.
 */
export const noteRateLimitsPending = async (ctx: CensusCtx, shardKey: string | undefined = currentUserShard()): Promise<void> => {
    if (shardKey === undefined) {
        return;
    }

    if (await bestEffort("noteRateLimitsPending", async () => await markRateLimitsPendingRow(ctx, shardKey))) {
        return;
    }

    await bestEffort("noteRateLimitsPending retry", async () => {
        await enqueueJob(internal.lib.shard_housekeeping.markRateLimitsPending, { shardKey }, { delayMs: RATE_LIMITS_PENDING_RETRY_MS, shardKey });
    });
};

/** The retry of a failed {@link noteRateLimitsPending} write. It throws on failure, so the queue delivers it again. */
export const markRateLimitsPending = internalMutation
    .input({ shardKey: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await markRateLimitsPendingRow(ctx, args.shardKey);

        return null;
    });

/**
 * On a user shard, from the dormant sweep: set the flag to whether the `rateLimits` table still holds a row. Clearing
 * writes first and reads again after, so a charge racing the sweep is never lost: a row added before the second read
 * is seen there and sets the flag back, and a charge after it finds the flag off and sets it itself
 * ({@link noteRateLimitsPending}, which runs after its row is written). Returns whether the flag is now off.
 */
export const settleRateLimitsPending = async (ctx: Pick<MutationCtx, "db">, shardKey: string | undefined = currentUserShard()): Promise<boolean> => {
    if (shardKey === undefined || (await ctx.db.query("rateLimits").first()) !== null) {
        return false;
    }

    let cleared = false;

    await bestEffort("settleRateLimitsPending", async () => {
        const row = await censusRow(ctx, shardKey);

        if (!row) {
            return;
        }

        await ctx.db.patch("shardActivity", row._id, { rateLimitsPending: false });

        if ((await ctx.db.query("rateLimits").first()) === null) {
            cleared = true;
        } else {
            await ctx.db.patch("shardActivity", row._id, { rateLimitsPending: true });
        }
    });

    return cleared;
};

/** `noteShardActivity` for callers outside a shard (the HTTP layer), run on the user's shard. */
export const recordShardActivity = internalMutation
    .input({ shardKey: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await noteShardActivity(ctx, args.shardKey);

        return null;
    });

/** Root, every minute: send {@link runShardTick} to each shard whose timed work is due. */
export const dispatchDueShards = internalMutation
    .input({})
    .output(v.object({ dispatched: v.number() }))
    .mutation(async ({ ctx }) => {
        const { now } = ctx;
        const { page: due } = await ctx.db.shardActivity.findMany({
            limit: DISPATCH_BATCH,
            orderBy: [{ nextDueAt: "asc" }],
            where: { nextDueAt: { lte: now } },
        });

        for (const row of due) {
            await runAfterOnShard(ctx.scheduler, 0, internal.lib.shard_housekeeping.runShardTick, {}, row.shardKey);
            // Cleared here, re-armed by the shard tick — so a slow tick is not dispatched twice.
            await patchRow(ctx.db, "shardActivity", row, { nextDueAt: undefined });
        }

        return { dispatched: due.length };
    });

/** Root, every ten minutes: send {@link runShardHousekeeping} to each shard that needs it. */
export const dispatchShardHousekeeping = internalMutation
    .input({})
    .output(v.object({ dispatched: v.number() }))
    .mutation(async ({ ctx }) => {
        const { now } = ctx;
        const { page: recent } = await ctx.db.shardActivity.findMany({
            limit: DISPATCH_BATCH * 5,
            orderBy: [{ lastActiveAt: "desc" }],
            where: { lastActiveAt: { gte: now - HOUSEKEEPING_HORIZON_MS } },
        });
        const due = recent.filter((row) => needsHousekeeping(row, now)).slice(0, DISPATCH_BATCH);

        for (const row of due) {
            await runAfterOnShard(ctx.scheduler, 0, internal.lib.shard_housekeeping.runShardHousekeeping, {}, row.shardKey);
            await ctx.db.patch("shardActivity", row._id, { housekeptAt: now });
        }

        return { dispatched: due.length };
    });

/**
 * Root, daily: send `sweepDormantShardRateLimits` (`lib/rate-limit-sweep.ts`) to each flagged shard idle past
 * {@link HOUSEKEEPING_HORIZON_MS}, which {@link dispatchShardHousekeeping} no longer visits. It reads only flagged rows,
 * through `by_rateLimitsPending_lastActiveAt`, a page per run; a full page schedules the next one after the last row's
 * (`lastActiveAt`, `_id`). That key is unique and stable, so a shard turning active between pages (it leaves the range)
 * or a tie on `lastActiveAt` cannot make the next page skip one. `before` is fixed by the first run, so the chain pages
 * one range, which never overlaps the housekeeping range (`lastActiveAt >= now - horizon`). A shard crossing the horizon
 * on the day may meet both; the sweep only deletes rows past every window, so a second run is a no-op.
 */
export const dispatchDormantRateLimitSweeps = internalMutation
    .input({
        after: v.optional(v.object({ id: v.id("shardActivity"), lastActiveAt: v.number() })),
        before: v.optional(v.number()),
    })
    .output(v.object({ dispatched: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const before = args.before ?? ctx.now - HOUSEKEEPING_HORIZON_MS;
        const { after } = args;
        const { page } = await ctx.db.shardActivity.findMany({
            limit: DISPATCH_BATCH,
            orderBy: [{ lastActiveAt: "asc" }, { _id: "asc" }],
            where: {
                lastActiveAt: { lt: before },
                rateLimitsPending: true,
                ...(after && { OR: [{ lastActiveAt: { gt: after.lastActiveAt } }, { _id: { gt: after.id }, lastActiveAt: after.lastActiveAt }] }),
            },
        });

        for (const row of page) {
            await runAfterOnShard(ctx.scheduler, 0, internal.lib.rate_limit_sweep.sweepDormantShardRateLimits, {}, row.shardKey);
        }

        const last = page.at(-1);

        if (page.length === DISPATCH_BATCH && last) {
            await ctx.scheduler.runAfter(0, internal.lib.shard_housekeeping.dispatchDormantRateLimitSweeps, {
                after: { id: last._id, lastActiveAt: last.lastActiveAt },
                before,
            });
        }

        return { dispatched: page.length };
    });

/**
 * On a user shard: fire due schedule triggers and recurring tasks, then re-arm
 * the census with this shard's next due time.
 */
export const runShardTick = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        // Also schedules `checkDueTasks` (see `triggers/schedule.ts`).
        await ctx.runMutation(internal.triggers.schedule.checkDueTriggers, {});
        // The export runs due on this shard (`usage/gdpr.ts`): the tick reaches an idle shard, so its runs are not left to the daily sweep.
        await bestEffort("sweepUsageExportPieces", async () => {
            await ctx.runMutation(internal.usage.gdpr.sweepUsageExportPieces, {});
        });
        // Event watchers whose next check is due; their checks run as actions. A failure here must not stop the reaping
        // and the re-arming below, or the shard's other schedules stall with it.
        await bestEffort("dispatchDueEventTriggers", async () => {
            await ctx.runMutation(internal.triggers.events.dispatchDueEventTriggers, {});
        });
        // Watched repositories whose poll is due (Develop); a failure here must not stall the re-arming below either.
        await bestEffort("dispatchDueRepoPolls", async () => {
            await ctx.runMutation(internal.source_control.freshness_internal.dispatchDueRepoPolls, {});
        });
        // Coding-agent turns that went silent; re-arms this shard for the next one to expire.
        const reaped = await bestEffort("reapHostStreams", async () => {
            await ctx.runMutation(internal.acp.ingest.reapHostStreams, {});
        });

        const { now } = ctx;
        // The earliest export run due here. A read that fails must not stop the re-arming below: the shard is then armed for now, as
        // a reap that failed is.
        const exportRunRead = await (async () => {
            try {
                const { page } = await ctx.db.usageExportRuns.findMany({ consistency: "primary", limit: 1, orderBy: [{ deleteAt: "asc" }] });

                return { deleteAt: page[0]?.deleteAt };
            } catch (error) {
                cronsLogger.warn("[housekeeping] the export run read failed:", error);

                return undefined;
            }
        })();
        const [trigger, task, repoPoll] = await Promise.all([
            // Only triggers with a next run armed: a schedule's first run or an event watcher's next check.
            // A webhook trigger has no `nextTriggerAt`, and `.first()` on the enabled prefix could return
            // one, which then armed the shard to tick every minute for nothing.
            ctx.db
                .query("triggers")
                .withIndex("by_enabled_nextTriggerAt", (q) => q.eq("enabled", true).gt("nextTriggerAt", 0))
                .first(),
            ctx.db
                .query("tasks")
                .withIndex("by_recurring_and_nextRunAt", (q) => q.eq("recurring", true))
                .first(),
            // The earliest armed poll of a watched repository (Develop): `gt(0)` leaves out a row nothing armed.
            ctx.db
                .query("watchedRepositories")
                .withIndex("by_nextPollAt", (q) => q.gt("nextPollAt", 0))
                .first(),
        ]);
        // The earliest stuck check of a blocked or failed task (`tasks/AGENTS.md`). Without it, a tick that re-arms the shard
        // drops the wake-up a stuck transition set, and the notice waits for the daily housekeeping instead.
        const stuckChecks = await Promise.all(
            (["blocked", "failed"] as const).map((status) =>
                ctx.db
                    .query("tasks")
                    .withIndex("by_status_and_stuckCheckAt", (q) => q.eq("status", status).gt("stuckCheckAt", 0))
                    .first(),
            ),
        );
        const candidates = [
            trigger?.nextTriggerAt,
            task?.nextRunAt,
            repoPoll?.nextPollAt,
            exportRunRead?.deleteAt,
            ...stuckChecks.map((row) => row?.stuckCheckAt),
        ].filter((at): at is number => at !== undefined);

        // The dispatch cleared this shard's due time; a reap or an export-run read that failed recorded no next time, so try again.
        if (!reaped || exportRunRead === undefined) {
            candidates.push(now);
        }

        if (candidates.length > 0) {
            await noteShardDue(ctx, Math.max(Math.min(...candidates), now + MIN_TICK_INTERVAL_MS));
        }

        return null;
    });

/** On a user shard: every cleanup sweep, one after another; a failure is logged and the rest still run. */
export const runShardHousekeeping = internalAction
    .input({})
    .output(v.object({ failed: v.array(v.string()) }))
    .action(async ({ ctx }) => {
        const failed: string[] = [];

        for (const sweep of shardSweeps()) {
            try {
                await ctx.runMutation(sweep.ref, {});
            } catch (error) {
                failed.push(sweep.name);
                cronsLogger.error(`[housekeeping] ${sweep.name} failed:`, error);
            }
        }

        // Stale task rounds (`checkDueTasks`), which the minute tick only visits on due shards.
        await ctx.runMutation(internal.tasks.internal.checkDueTasks, {}).catch((error: unknown) => {
            failed.push("checkDueTasks");
            cronsLogger.error("[housekeeping] checkDueTasks failed:", error);
        });

        return { failed };
    });
