/**
 * The `threads` triggers that keep palette-search vectors in step with the row
 * (`thread-search.ts`). Each only computes what changed and schedules a sync or a
 * cleanup; the work runs in the scheduler, not in the writing mutation.
 *
 * `internal` is imported when a trigger fires, not at load: `schema.ts` loads this
 * module, and a static import would load the generated references before the
 * test harness can map them.
 */
import type { TriggerBuilder, TriggerCtx } from "lunorash/server";

import type { Id } from "../_generated/dataModel";

import { SEARCH_KINDS, SEARCH_VECTOR_FIELD, type SearchRow, searchKindsChanged } from "./thread-search-plan";

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
 */
const scheduleOrLog = async (
    context: TriggerCtx,
    pick: (internal: Internal) => ScheduledTarget,
    args: Record<string, unknown>,
    options?: { retry: typeof SYNC_RETRY },
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

                await context.scheduler.runAfter(0, internal.agent.thread_search.deleteThreadVectors, { vectorIds });
            }
        }),
        threadSearchInsert: t.afterInsert(async (context, event) => {
            const changed = searchKindsChanged(undefined, event.doc as unknown as SearchRow);

            if (changed.length > 0) {
                await scheduleOrLog(
                    context,
                    (internal) => internal.agent.thread_search.syncThreadSearch,
                    { changed, threadId: event.id },
                    { retry: SYNC_RETRY },
                );
            }
        }),
        threadSearchUpdate: t.afterUpdate(async (context, event) => {
            const changed = searchKindsChanged(event.previous as unknown as SearchRow, event.doc as unknown as SearchRow);

            if (changed.length > 0) {
                await scheduleOrLog(
                    context,
                    (internal) => internal.agent.thread_search.syncThreadSearch,
                    { changed, threadId: event.id },
                    { retry: SYNC_RETRY },
                );
            }
        }),
    };
};

/**
 * The messages table's trigger for the turn gate. Deleting a user turn can take a thread from
 * four user turns to three, so its vectors must be re-checked: a sync with no changed kinds
 * clears a thread that no longer qualifies. Only user rows schedule one, so a delete of tool or
 * assistant rows costs nothing.
 */
export const threadSearchMessageTriggers = (t: TriggerBuilder) => {
    return {
        threadSearchTurnDelete: t.afterDelete(async (context, event) => {
            const previous = event.previous as unknown as { message?: { role?: unknown }; threadId?: Id<"threads"> };

            if (previous.message?.role !== "user" || previous.threadId === undefined) {
                return;
            }

            await scheduleOrLog(
                context,
                (internal) => internal.agent.thread_search.syncThreadSearch,
                { changed: [], threadId: previous.threadId },
                { retry: SYNC_RETRY },
            );
        }),
    };
};
