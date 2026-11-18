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

import { SEARCH_KINDS, SEARCH_VECTOR_FIELD, type SearchRow, searchKindsChanged } from "./thread-search-plan";

type Internal = (typeof import("../_generated/internal"))["internal"];
type ScheduledTarget = Parameters<TriggerCtx["scheduler"]["runAfter"]>[1];

/**
 * A failed schedule does not fail the thread write that caused it: the index is derived data, and the thread's next write
 * queues the sync again. The failure is logged, not thrown.
 */
const scheduleOrLog = async (context: TriggerCtx, pick: (internal: Internal) => ScheduledTarget, args: Record<string, unknown>): Promise<void> => {
    try {
        const { internal } = await import("../_generated/internal");

        await context.scheduler.runAfter(0, pick(internal), args);
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
                await scheduleOrLog(context, (internal) => internal.agent.thread_search.deleteThreadVectors, { vectorIds });
            }
        }),
        threadSearchInsert: t.afterInsert(async (context, event) => {
            const changed = searchKindsChanged(undefined, event.doc as unknown as SearchRow);

            if (changed.length > 0) {
                await scheduleOrLog(context, (internal) => internal.agent.thread_search.syncThreadSearch, { changed, threadId: event.id });
            }
        }),
        threadSearchUpdate: t.afterUpdate(async (context, event) => {
            const changed = searchKindsChanged(event.previous as unknown as SearchRow, event.doc as unknown as SearchRow);

            if (changed.length > 0) {
                await scheduleOrLog(context, (internal) => internal.agent.thread_search.syncThreadSearch, { changed, threadId: event.id });
            }
        }),
    };
};
