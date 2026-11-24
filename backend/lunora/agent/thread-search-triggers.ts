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
 * How a deleted thread's vector cleanup is retried: until it succeeds. The scheduler's default
 * policy dead-letters a job after five retries, and nothing later queues this cleanup again, since
 * the thread row is gone. The cleanup is idempotent (a vector already removed is skipped), and
 * `forever` caps the wait between attempts at 30 minutes.
 */
export const CLEANUP_RETRY = { backoff: "exponential", baseMs: 60_000, forever: true } as const;

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
                    shardKey === undefined ? { retry: CLEANUP_RETRY } : { retry: CLEANUP_RETRY, shardKey },
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

            // Archived or restored, by whatever writer: the thread's vectors carry the flag a meaning search filters on.
            // Not logged and swallowed as the sync is: no later write queues this again (the one-time backfill may be done),
            // so a failed schedule fails the archive or restore, and the job retries until it lands (it is idempotent).
            if (archivedChanged(event.previous as unknown as SearchRow, doc) && hasSearchVector(doc) && doc.userId !== undefined) {
                const { internal } = await import("../_generated/internal");

                await context.scheduler.runAfter(
                    0,
                    internal.agent.thread_vector_archived.syncThreadVectorArchived,
                    { threadId: event.id },
                    { retry: CLEANUP_RETRY, shardKey: doc.userId },
                );
            }
        }),
    };
};

/** Pure: whether a write moved the thread into or out of `archived`. */
export const archivedChanged = (previous: Pick<SearchRow, "status">, doc: Pick<SearchRow, "status">): boolean =>
    (previous.status === "archived") !== (doc.status === "archived");

const hasSearchVector = (row: SearchRow): boolean => SEARCH_KINDS.some((kind) => row[SEARCH_VECTOR_FIELD[kind]] !== undefined);

/** A thread's user-turn count; a thread written before the count existed has none. */
const userTurnsOf = (thread: Record<string, unknown>): number => (typeof thread.userTurnCount === "number" ? thread.userTurnCount : 0);

/** Whether a messages row is a user turn of a thread. */
const isUserTurn = (row: { message?: { role?: unknown }; threadId?: string }): row is { message: { role: "user" }; threadId: string } =>
    row.message?.role === "user" && row.threadId !== undefined;

/**
 * Moves a thread's user-turn count by `delta`, and schedules a sync when the move crosses the gate,
 * either way: up, a thread that just qualified gets its vectors without waiting for a reply (a fork,
 * a messenger turn or a failed reply sets no `lastReplyAt`); down, its vectors are cleared. A thread
 * already being hard-deleted is left alone: its cleanup removes the vectors.
 */
const moveUserTurns = async (context: TriggerCtx, threadId: string, delta: 1 | -1): Promise<void> => {
    const thread = await context.db.get("threads", threadId);

    if (thread === null || thread.deletingAt !== undefined || typeof thread.userId !== "string") {
        return;
    }

    const before = userTurnsOf(thread);
    const after = Math.max(0, before + delta);

    await context.db.patch("threads", threadId, { userTurnCount: after });

    if (hasEnoughTurns(before) === hasEnoughTurns(after)) {
        return;
    }

    // `changed: []`: the sync embeds each kind with text and no vector, and clears every vector once the thread is below the gate.
    await scheduleOrLog(
        context,
        (internal) => internal.agent.thread_search.syncThreadSearch,
        { changed: [], threadId },
        { retry: SYNC_RETRY, shardKey: thread.userId },
    );
};

/**
 * The messages table's triggers for the palette's turn gate. A user turn inserted adds one to the
 * count on its thread row, a user turn deleted takes one away, and a row whose role changes to or
 * from `user` (a pending row overwritten by `updateMessage` or an abandon) moves it too. A sync is
 * scheduled only when the count crosses the gate (`moveUserTurns`). Triggers run for every writer of
 * `messages`, so no writer keeps the count itself.
 */
export const threadSearchMessageTriggers = (t: TriggerBuilder) => {
    return {
        threadSearchTurnDelete: t.afterDelete(async (context, event) => {
            const previous = event.previous as unknown as { message?: { role?: unknown }; threadId?: string };

            if (isUserTurn(previous)) {
                await moveUserTurns(context, previous.threadId, -1);
            }
        }),
        threadSearchTurnInsert: t.afterInsert(async (context, event) => {
            const doc = event.doc as unknown as { message?: { role?: unknown }; threadId?: string };

            if (isUserTurn(doc)) {
                await moveUserTurns(context, doc.threadId, 1);
            }
        }),
        threadSearchTurnUpdate: t.afterUpdate(async (context, event) => {
            const previous = event.previous as unknown as { message?: { role?: unknown }; threadId?: string };
            const doc = event.doc as unknown as { message?: { role?: unknown }; threadId?: string };

            if (isUserTurn(doc) && !isUserTurn(previous)) {
                await moveUserTurns(context, doc.threadId, 1);
            } else if (isUserTurn(previous) && !isUserTurn(doc)) {
                await moveUserTurns(context, previous.threadId, -1);
            }
        }),
    };
};
