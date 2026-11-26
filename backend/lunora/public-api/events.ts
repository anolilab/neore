/**
 * The shard side of `events/poll` and the retention sweep. Both are internal: the MCP dispatcher calls `pollEvents` after the
 * key is authenticated and scoped, and on the key owner's shard, so the `userId` it passes is the caller's own.
 *
 * The cursor is decoded and encoded by the router (`router.ts`), where the signing secret lives. These functions speak in
 * seq numbers only.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { checkUserBanStatus, enforceBanStatus } from "../lib/crpc-auth-helpers";
import { isThreadLocked } from "../lib/thread-lock";
import { internalMutation, internalQuery } from "../_generated/server";
import { pollEvents as pollLog } from "./events-poll";
import type { EventLogStore } from "./events-poll";
import { deleteMcpEventsOfThread, EVENT_WAKE_MAX_ATTEMPTS, EVENT_WAKE_RETRY_MS, RETENTION_MS, recordRunEnd } from "./events-log";
import { noteRetentionWake } from "../lib/shard-housekeeping";
import { currentUserShard } from "../lib/shard-context";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { internal } from "../_generated/internal";

/** Rows the sweep deletes per call. The sweep runs again while it reports more. */
const PRUNE_BATCH = 200;

/**
 * Whether an event belongs to a chat a poll leaves out: a locked one, or one in the trash. The thread list omits both, and their events
 * carry the same thread id, so their metadata is kept from the key the same way. Trashing a chat deletes its events (`softDeleteThread`),
 * so the trash check covers only the ones recorded while it is in the trash or not yet removed by that cleanup.
 * Each thread is read once per poll.
 */
const hiddenByThread = (ctx: QueryCtx) => {
    const hidden = new Map<string, boolean>();

    return async (event: { data: Record<string, unknown> }): Promise<boolean> => {
        const { threadId } = event.data;

        if (typeof threadId !== "string") {
            return false;
        }

        const known = hidden.get(threadId);

        if (known !== undefined) {
            return known;
        }

        // From the primary: a replica that lags a lock would show the locked thread's events as unlocked.
        const thread = await ctx.db.threads.findFirst({ consistency: "primary", where: { _id: threadId as Id<"threads"> } });
        const isHidden = thread !== null && (isThreadLocked(thread) || thread.deleted === true);

        hidden.set(threadId, isHidden);

        return isHidden;
    };
};

const storeOn = (ctx: QueryCtx, userId: string): EventLogStore => {
    return {
        after: async (afterSeq, limit) => {
            // From the primary: a replica that lags behind a just-recorded event would let the poll move its cursor past it.
            const { page } = await ctx.db.mcpEvents.findMany({
                consistency: "primary",
                limit,
                orderBy: [{ seq: "asc" }],
                where: { seq: { gt: afterSeq }, userId },
            });

            return page.map((row) => {
                return {
                    createdAt: row.createdAt,
                    data: JSON.parse(row.data) as Record<string, unknown>,
                    eventId: row.eventId,
                    name: row.name,
                    seq: row.seq,
                    timestamp: row.timestamp,
                };
            });
        },
        latestSeq: async () => {
            const watermark = await ctx.db.mcpEventWatermarks.findFirst({ consistency: "primary", where: { userId } });

            return watermark?.seq ?? 0;
        },
        prunedThrough: async () => {
            const watermark = await ctx.db.mcpEventWatermarks.findFirst({ consistency: "primary", where: { userId } });

            return watermark?.prunedThrough ?? 0;
        },
    };
};

/**
 * One `events/poll`, answered from `userId`'s log. `fromSeq` absent means "start from now": no events, and the log's
 * current end as the position. Errors are the router's: this function does not reject for an unknown name, the router
 * checks the catalog first.
 */
export const pollEvents = internalQuery
    .input({
        fromSeq: v.optional(v.number()),
        maxAgeMs: v.optional(v.number()),
        maxEvents: v.number(),
        name: v.string(),
        threadId: v.optional(v.string()),
        userId: v.string(),
    })
    .output(
        v.object({
            events: v.array(
                v.object({
                    data: v.string(),
                    eventId: v.string(),
                    name: v.string(),
                    timestamp: v.number(),
                }),
            ),
            hasMore: v.boolean(),
            nextSeq: v.number(),
            truncated: v.boolean(),
        }),
    )
    .query(async ({ args, ctx }) => {
        // A banned account reads nothing. Every other public route enforces this in its builder, and the poll reaches the log directly,
        // so the check is made here, on the same row the builders read.
        const user = await ctx.db.user.findFirst({ consistency: "primary", where: { _id: args.userId as Id<"user"> } });

        enforceBanStatus(checkUserBanStatus(user));

        const outcome = await pollLog(storeOn(ctx, args.userId), {
            fromSeq: args.fromSeq ?? null,
            hidden: hiddenByThread(ctx),
            // The window never reaches past retention: an event older than it is expired whether or not housekeeping has pruned it yet,
            // so a dormant shard's backlog is never read back to a returning user.
            maxAgeMs: args.maxAgeMs === undefined ? RETENTION_MS : Math.min(args.maxAgeMs, RETENTION_MS),
            maxEvents: args.maxEvents,
            name: args.name,
            now: ctx.now,
            threadId: args.threadId,
        });

        return {
            events: outcome.events.map((event) => {
                return { ...event, data: JSON.stringify(event.data) };
            }),
            hasMore: outcome.hasMore,
            nextSeq: outcome.nextSeq,
            truncated: outcome.truncated,
        };
    });

/**
 * The retention sweep, run per shard (`runShardHousekeeping` in `lib/shard-housekeeping.ts`). Deletes up to `PRUNE_BATCH`
 * events older than the window, the highest of a log included: the sequence is kept in `mcpEventWatermarks`, so it does not
 * restart. `hasMore` says a full batch was deleted, so the caller calls again.
 */
export const pruneMcpEvents = internalMutation.output(v.object({ hasMore: v.boolean(), removed: v.number() })).mutation(async ({ ctx }) => {
    const cutoff = ctx.now - RETENTION_MS;
    const { page } = await ctx.db.mcpEvents.findMany({ limit: PRUNE_BATCH, where: { createdAt: { lt: cutoff } } });

    // The highest seq the sweep expired for each user: the poll's gap check reads it from the watermark. An event of a locked or trashed
    // chat does not count: the poll hides it, so its expiry is no gap the client could have missed, and reporting one would reveal that
    // the chat had activity. The predicate is the poll's own (`hiddenByThread`).
    const expired = new Map<string, number>();
    const hiddenThreads = new Map<string, boolean>();
    const isHidden = async (threadId: string | undefined): Promise<boolean> => {
        if (threadId === undefined) {
            return false;
        }

        const known = hiddenThreads.get(threadId);

        if (known !== undefined) {
            return known;
        }

        const thread = await ctx.db.threads.findFirst({ consistency: "primary", where: { _id: threadId as Id<"threads"> } });
        const hidden = thread !== null && (isThreadLocked(thread) || thread.deleted === true);

        hiddenThreads.set(threadId, hidden);

        return hidden;
    };

    for (const row of page) {
        await ctx.db.delete("mcpEvents", row._id);

        if (!(await isHidden(row.threadId))) {
            expired.set(row.userId, Math.max(expired.get(row.userId) ?? 0, row.seq));
        }
    }

    for (const [userId, seq] of expired) {
        const watermark = await ctx.db.mcpEventWatermarks.findFirst({ consistency: "primary", where: { userId } });

        if (watermark !== null && (watermark.prunedThrough ?? 0) < seq) {
            await ctx.db.patch("mcpEventWatermarks", watermark._id, { prunedThrough: seq });
        }
    }

    const hasMore = page.length === PRUNE_BATCH;

    // The shard has one retention time, shared with the other retained rows (`gdpr/retention.ts`), which sets it from all of them,
    // this log's oldest event included. This sweep never writes it, so it cannot delay another table's expiry. A full batch only
    // asks for the next one now.
    if (hasMore) {
        await noteRetentionWake(ctx, ctx.now);
    }

    return { hasMore, removed: page.length };
});

/**
 * The rest of an expired backlog, one batch per call. The shard's housekeeping tick takes the first batch and hands the rest here, so a
 * backlog does not repeat the whole tick (its triggers, exports and sweeps) once per batch. Each call runs in its own transaction and
 * schedules the next while a full batch was deleted.
 */
export const pruneMcpEventsBacklog = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const { hasMore } = await ctx.runMutation(internal.public_api.events.pruneMcpEvents, {});
        const shardKey = currentUserShard();

        if (hasMore && shardKey !== undefined) {
            await runAfterOnShard(ctx.scheduler, 0, internal.public_api.events.pruneMcpEventsBacklog, {}, shardKey);
        }

        return null;
    });

/**
 * The retry of a wake that failed (`wakeForExpiry` in `events-log.ts`), run on the owner's shard: it writes the wake again, or schedules the
 * next attempt after a longer wait. After the last attempt it fails visibly, so the gap shows in the job's record.
 */
export const retryEventWake = internalMutation
    .input({ attempt: v.number(), dueAt: v.number(), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        if (await noteRetentionWake(ctx, args.dueAt, args.userId)) {
            return null;
        }

        if (args.attempt >= EVENT_WAKE_MAX_ATTEMPTS) {
            throw new LunoraError("INTERNAL", `The Events log's wake for ${args.userId} could not be written after ${String(args.attempt)} attempts.`);
        }

        await runAfterOnShard(
            ctx.scheduler,
            EVENT_WAKE_RETRY_MS * 2 ** (args.attempt - 1),
            internal.public_api.events.retryEventWake,
            { attempt: args.attempt + 1, dueAt: args.dueAt, userId: args.userId },
            args.userId,
        );

        return null;
    });

/**
 * How a headless run ended, for its thread's owner (`chat/lib/headless-run.ts`). A headless run has no stream row, so its own reply key
 * stands for the stream in the event's id: one run, one end, however often it is written.
 */
export const recordHeadlessRunEnd = internalMutation
    .input({ outcome: v.union(v.literal("succeeded"), v.literal("failed")), runKey: v.string(), threadId: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await recordRunEnd({ db: ctx.db, now: ctx.now, scheduler: ctx.scheduler }, { outcome: args.outcome, streamId: args.runKey, threadId: args.threadId });

        return null;
    });

/**
 * The rest of a trashed chat's events, one batch per call (`softDeleteThread` in `agent/threads.ts` runs the first batch in the trash
 * write and schedules this for any left). Each call runs in its own transaction and schedules the next while events remain. It stops
 * once the chat is no longer in the trash, which restore allows only after `drainTrashedThreadEvents` has removed every event.
 */
export const deleteTrashedThreadEvents = internalMutation
    .input({ threadId: v.string(), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.threads.findFirst({ consistency: "primary", where: { _id: args.threadId as Id<"threads"> } });

        if (thread === null || thread.deleted !== true) {
            return null;
        }

        if (!(await deleteMcpEventsOfThread(ctx, args.userId, args.threadId))) {
            await runAfterOnShard(ctx.scheduler, 0, internal.public_api.events.deleteTrashedThreadEvents, args, args.userId);
        }

        return null;
    });

/**
 * One batch of a trashed chat's events, run before its restore (`undoDeleteThread` in `chat/functions.ts`). The restore runs after it in
 * its own transaction, and refuses while events remain, so a restored chat never shows events the trash meant to remove. Returns `true`
 * once none are left.
 */
export const drainTrashedThreadEvents = internalMutation
    .input({ threadId: v.string(), userId: v.string() })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.threads.findFirst({ consistency: "primary", where: { _id: args.threadId as Id<"threads"> } });

        // Only a trashed chat drains: a chat that is live (already restored, or restored by a concurrent undo) keeps the events it has.
        if (thread === null || thread.deleted !== true) {
            return true;
        }

        return await deleteMcpEventsOfThread(ctx, args.userId, args.threadId);
    });
