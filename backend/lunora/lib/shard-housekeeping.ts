/**
 * Periodic work on every user's shard, driven from the root cron tick.
 *
 * The cron tick runs on `__root__`, but the tables its sweeps scan — expired
 * temporary chats and streams, stale presence, lapsed claims, due triggers and
 * tasks, GDPR request timeouts — now live on each user's own shard
 * (docs/plans/per-user-sharding.md). So the tick FANS OUT: a `.global()` census
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
 *
 * Each dispatch goes on the target user's own scheduler lane
 * (`shard-scheduler.ts`), so shards are swept side by side, not one at a time.
 */
import type { FunctionReference } from "lunorash/client";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { internalAction, internalMutation } from "../_generated/server";
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
const DISPATCH_BATCH = 200;

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
    { name: "cleanupExpiredPersistentStreams", ref: internal.chat.streaming.persistent.crons.cleanupExpiredStreams },
    { name: "cleanupStaleWorkflowPresence", ref: internal.workflow.presence.cleanupStalePresence },
    { name: "reapLapsedClaims", ref: internal.lib.claim_once.reapLapsedClaims },
    { name: "purgeIdempotencyClaims", ref: internal.lib.claim_once.purgeExpiredClaims },
    { name: "deleteExpiredTemporaryChats", ref: internal.crons.deleteExpiredTemporaryChats },
    { name: "cleanupExpiredExports", ref: internal.gdpr.request_sweeps.cleanupExpiredExports },
    { name: "handleGdprRequestTimeouts", ref: internal.gdpr.request_sweeps.handleGdprRequestTimeouts },
    { name: "pruneOldNotifications", ref: internal.notifications.functions.pruneOldNotifications },
    { name: "sweepDeviceCalls", ref: internal.devices.internal.sweepDeviceCalls },
    { name: "sweepKnowledgeFiles", ref: internal.knowledge.housekeeping.sweepKnowledgeFiles },
    { name: "pruneRetainedActivity", ref: internal.gdpr.retention.pruneRetainedActivity },
    { name: "sweepUsageRollup", ref: internal.usage.backfill.sweepUsageRollup },
    { name: "sweepStagedChatUploads", ref: internal.file.sweepStagedChatUploads },
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
const bestEffort = async (what: string, write: () => Promise<void>): Promise<void> => {
    try {
        await write();
    } catch (error) {
        cronsLogger.warn(`[housekeeping] ${what} failed:`, error);
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
            await ctx.db.patch(row._id, { lastActiveAt: now });
        } else {
            await ctx.db.insert("shardActivity", { lastActiveAt: now, shardKey });
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
            await ctx.db.patch(row._id, { nextDueAt: dueAt });
        }
    });
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
        const now = ctx.now;
        const { page: due } = await ctx.db.shardActivity.findMany({
            limit: DISPATCH_BATCH,
            orderBy: [{ nextDueAt: "asc" }],
            where: { nextDueAt: { lte: now } },
        });

        for (const row of due) {
            await runAfterOnShard(ctx.scheduler, 0, internal.lib.shard_housekeeping.runShardTick, {}, row.shardKey);
            // Cleared here, re-armed by the shard tick — so a slow tick is not dispatched twice.
            await patchRow(ctx.db, row, { nextDueAt: undefined });
        }

        return { dispatched: due.length };
    });

/** Root, every ten minutes: send {@link runShardHousekeeping} to each shard that needs it. */
export const dispatchShardHousekeeping = internalMutation
    .input({})
    .output(v.object({ dispatched: v.number() }))
    .mutation(async ({ ctx }) => {
        const now = ctx.now;
        const { page: recent } = await ctx.db.shardActivity.findMany({
            limit: DISPATCH_BATCH * 5,
            orderBy: [{ lastActiveAt: "desc" }],
            where: { lastActiveAt: { gte: now - HOUSEKEEPING_HORIZON_MS } },
        });
        const due = recent.filter((row) => needsHousekeeping(row, now)).slice(0, DISPATCH_BATCH);

        for (const row of due) {
            await runAfterOnShard(ctx.scheduler, 0, internal.lib.shard_housekeeping.runShardHousekeeping, {}, row.shardKey);
            await ctx.db.patch(row._id, { housekeptAt: now });
        }

        return { dispatched: due.length };
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

        const now = ctx.now;
        const [trigger, task] = await Promise.all([
            ctx.db
                .query("triggers")
                .withIndex("by_enabled_nextTriggerAt", (q) => q.eq("enabled", true))
                .first(),
            ctx.db
                .query("tasks")
                .withIndex("by_recurring_and_nextRunAt", (q) => q.eq("recurring", true))
                .first(),
        ]);
        const candidates = [trigger?.nextTriggerAt ?? (trigger ? now : undefined), task?.nextRunAt].filter((at): at is number => at !== undefined);

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
