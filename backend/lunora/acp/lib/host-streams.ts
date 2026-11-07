/** Reads of a thread's host streams that stay bounded however long its turn history grows. */

import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

/** How many of a status's newest streams are looked at for a host one: a host thread's streams are all host streams. */
const HOST_STREAMS_CHECKED = 5;

/**
 * The newest host stream of the thread in one of `statuses`. One read per status through `by_threadId_status`, newest first
 * and capped, so a session read costs the same however long the thread's turn history grows.
 */
export const newestHostStream = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">, statuses: ReadonlyArray<string>) => {
    let newest: Doc<"persistentStreams"> | undefined;

    for (const status of statuses) {
        const rows = await ctx.db
            .query("persistentStreams")
            .withIndex("by_threadId_status", (q) => q.eq("threadId", threadId).eq("status", status))
            .order("desc")
            .take(HOST_STREAMS_CHECKED);
        const row = rows.find((candidate) => candidate.producer === "host");

        if (row !== undefined && (newest === undefined || row._creationTime > newest._creationTime)) {
            newest = row;
        }
    }

    return newest;
};
