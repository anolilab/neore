/**
 * The `threads` and `messages` triggers that keep palette-search vectors in step with the
 * row (`thread-search.ts`). Each only computes what changed and schedules a sync or a
 * cleanup; the work runs in the scheduler, not in the writing mutation.
 *
 * `internal` is imported when a trigger fires, not at load: `schema.ts` loads this
 * module, and a static import would load the generated references before the
 * test harness can map them.
 */
import type { TriggerBuilder, TriggerCtx } from "lunorash/server";

import { hasEnoughTurns, SEARCH_KINDS, SEARCH_VECTOR_FIELD, type SearchRow, searchKindsChanged } from "./thread-search-plan";

type Internal = (typeof import("../_generated/internal"))["internal"];
type ScheduledTarget = Parameters<TriggerCtx["scheduler"]["runAfter"]>[1];

/**
 * How a sync that fails (the gateway is down) is retried. Without it a thread whose
 * last sync failed stays unindexed until its next write, which for an idle thread
 * may never come.
 */
export const SYNC_RETRY = { backoff: "exponential", baseMs: 60_000, maxAttempts: 5 } as const;

/**
 * A failed schedule does not fail the thread write that caused it: the index is derived data, and the thread's next write
 * queues the sync again. The failure is logged, not thrown.
 *
 * `shardKey` is the thread owner's user id: the sync reads a user-sharded thread, so it must run on that user's shard.
 */
const scheduleOrLog = async (
    context: TriggerCtx,
    pick: (internal: Internal) => ScheduledTarget,
    args: Record<string, unknown>,
    options: { retry: typeof SYNC_RETRY; shardKey?: string },
): Promise<void> => {
    try {
        const { internal } = await import("../_generated/internal");

        await context.scheduler.runAfter(0, pick(internal), args, options);
    } catch (error) {
        console.warn("[agent/thread-search] Could not schedule the palette index update:", error);
    }
};

export const threadSearchTriggers = (t: TriggerBuilder) => {
    return {
        threadSearchDelete: t.afterDelete(async (context, event) => {
            const previous = event.previous as unknown as SearchRow;
            const vectorIds = SEARCH_KINDS.flatMap((kind) => {
                const id = previous[SEARCH_VECTOR_FIELD[kind]];

                return id === undefined ? [] : [id];
            });

            if (vectorIds.length > 0) {
                // Not logged and swallowed as the others are: a deleted thread gets no later write that would queue this
                // cleanup again, so a failed schedule must fail the delete, which then runs again.
                const { internal } = await import("../_generated/internal");

                // The vector rows live on the owner's shard. Without the owner's key the cleanup runs on the default shard and
                // finds nothing, so the key is passed whenever the thread has an owner.
                const shardKey = previous.userId;

                await context.scheduler.runAfter(
                    0,
                    internal.agent.thread_search.deleteThreadVectors,
                    { vectorIds },
                    shardKey === undefined ? undefined : { shardKey },
                );
            }
        }),
        threadSearchInsert: t.afterInsert(async (context, event) => {
            const doc = event.doc as unknown as SearchRow;
            const changed = searchKindsChanged(undefined, doc);

            if (changed.length > 0 && doc.userId !== undefined) {
                await scheduleOrLog(
                    context,
                    (internal) => internal.agent.thread_search.syncThreadSearch,
                    { changed, threadId: event.id },
                    { retry: SYNC_RETRY, shardKey: doc.userId },
                );
            }
        }),
        threadSearchUpdate: t.afterUpdate(async (context, event) => {
            const doc = event.doc as unknown as SearchRow;
            const changed = searchKindsChanged(event.previous as unknown as SearchRow, doc);

            if (changed.length > 0 && doc.userId !== undefined) {
                await scheduleOrLog(
                    context,
                    (internal) => internal.agent.thread_search.syncThreadSearch,
                    { changed, threadId: event.id },
                    { retry: SYNC_RETRY, shardKey: doc.userId },
                );
            }
        }),
    };
};

/** A thread's user-turn count; a thread written before the count existed has none. */
const userTurnsOf = (thread: Record<string, unknown>): number => (typeof thread.userTurnCount === "number" ? thread.userTurnCount : 0);

/**
 * The messages table's triggers for the palette's turn gate. A thread's user-turn count lives on
 * the thread row. A user turn inserted adds one. A user turn deleted takes one away, and schedules
 * a sync only when that delete takes the thread below the gate, since that is the only change that
 * clears vectors. A thread already being hard-deleted is left alone: its cleanup removes the vectors.
 * Triggers run for every writer of `messages`, so no writer keeps the count itself.
 */
export const threadSearchMessageTriggers = (t: TriggerBuilder) => {
    return {
        threadSearchTurnDelete: t.afterDelete(async (context, event) => {
            const previous = event.previous as unknown as { message?: { role?: unknown }; threadId?: string };

            if (previous.message?.role !== "user" || previous.threadId === undefined) {
                return;
            }

            const thread = await context.db.get("threads", previous.threadId);

            if (thread === null || thread.deletingAt !== undefined || typeof thread.userId !== "string") {
                return;
            }

            const before = userTurnsOf(thread);
            const after = Math.max(0, before - 1);

            await context.db.patch("threads", previous.threadId, { userTurnCount: after });

            if (hasEnoughTurns(before) && !hasEnoughTurns(after)) {
                await scheduleOrLog(
                    context,
                    (internal) => internal.agent.thread_search.syncThreadSearch,
                    { changed: [], threadId: previous.threadId },
                    { retry: SYNC_RETRY, shardKey: thread.userId },
                );
            }
        }),
        threadSearchTurnInsert: t.afterInsert(async (context, event) => {
            const doc = event.doc as unknown as { message?: { role?: unknown }; threadId?: string };

            if (doc.message?.role !== "user" || doc.threadId === undefined) {
                return;
            }

            const thread = await context.db.get("threads", doc.threadId);

            if (thread !== null) {
                await context.db.patch("threads", doc.threadId, { userTurnCount: userTurnsOf(thread) + 1 });
            }
        }),
    };
};
