/**
 * A steer waiting on a run is the user's message text, stored on the run's
 * `persistentStreams` row (`chat/steering.ts`). When its thread is deleted,
 * nothing will deliver or withdraw it, so it goes with the thread
 * (`agent/threads.ts`, next to the tool-approval snapshots).
 */
import type { MutationCtx } from "../../_generated/server";

const PAGE_SIZE = 100;

/**
 * Drops every still-queued steer on the thread's streams, a page at a time in
 * one mutation. Delivered entries hold no text and stay. Sequential: the
 * patches are audited writes.
 */
export const dropQueuedSteersForThread = async (ctx: Pick<MutationCtx, "db">, threadId: string): Promise<number> => {
    let cursor: string | null = null;
    let dropped = 0;

    while (true) {
        const page = await ctx.db
            .query("persistentStreams")
            .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
            .paginate({ cursor, numItems: PAGE_SIZE });

        for (const stream of page.page) {
            const queued = stream.steers?.filter((entry) => entry.status === "queued") ?? [];

            if (queued.length > 0) {
                await ctx.db.patch(stream._id, { steers: (stream.steers ?? []).filter((entry) => entry.status !== "queued") });
                dropped += queued.length;
            }
        }

        if (page.isDone) {
            return dropped;
        }

        cursor = page.continueCursor;
    }
};
