/**
 * What a thread's context summaries carry into a device call (`devices/internal.ts#createDeviceCall`).
 *
 * The model reads a summary as notes in its system prompt, so it was shaped by every row the summary folded in,
 * tool output and attachments included. The call's own `taintedBy` (`devices/lib/taint.ts`) only sees the
 * messages left in the window, so without this a call made after the web page scrolled out of it would not ask.
 *
 * It takes the union over ALL the thread's summaries, not only the one the run reads: which one that is depends
 * on the prompt's path, and over-asking is the safe direction.
 */
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { type DeviceTaintSource, mergeTaint } from "../devices/lib/taint";
import { SUMMARIES_KEPT_PER_THREAD } from "./thread-summary-logic";

export const threadSummaryTaint = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">): Promise<DeviceTaintSource[]> => {
    const rows = await ctx.db
        .query("threadContextSummaries")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .take(SUMMARIES_KEPT_PER_THREAD + 2);

    return mergeTaint(...rows.map((row) => row.taintedBy));
};
