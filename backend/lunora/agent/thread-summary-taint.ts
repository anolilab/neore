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
import { agentSwitchOf } from "./agent-switch-logic";
import { SUMMARIES_KEPT_PER_THREAD } from "./thread-summary-logic";

export const threadSummaryTaint = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">): Promise<DeviceTaintSource[]> => {
    const rows = await ctx.db
        .query("threadContextSummaries")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .take(SUMMARIES_KEPT_PER_THREAD + 2);

    return mergeTaint(...rows.map((row) => row.taintedBy));
};

/**
 * What a handoff taken over from a coding agent carries into a device call. Such a thread (harness switch S3) starts with a
 * `portable` divider holding the agent's output, written by an agent that ran commands and read files and pages on the
 * user's computer. None of those tool results exist in this thread, so `computeTaint` cannot see them: the thread is
 * treated as having read a page and a device, for as long as it lasts.
 */
export const HOST_HANDOFF_TAINT: DeviceTaintSource[] = ["web", "device"];

export const threadHandoffTaint = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">): Promise<DeviceTaintSource[]> => {
    const thread = await ctx.db.threads.findFirst({ where: { _id: threadId } });

    if (!thread?.hasHandoff) {
        return [];
    }

    // The divider that makes a thread a takeover is its first row.
    const first = await ctx.db.messages.findFirst({ orderBy: [{ order: "asc" }, { stepOrder: "asc" }], where: { threadId } });
    const part = first && agentSwitchOf(first);

    return part?.from.kind === "host" && part.handoff ? HOST_HANDOFF_TAINT : [];
};
