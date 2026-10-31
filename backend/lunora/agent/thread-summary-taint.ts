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
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { computeTaint, type DeviceTaintSource, mergeTaint } from "../devices/lib/taint";
import { agentSwitchOf } from "./agent-switch-logic";
import { walkPath } from "./branch-rows";
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
 * `portable` divider holding the agent's output (or nothing, when it said nothing in words), written by an agent that ran commands and read files and pages on the
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

    return part?.from.kind === "host" ? HOST_HANDOFF_TAINT : [];
};

/** Rows of a path read for its taint: 3,000, as far as a search for an earlier divider goes (`handoff-source.ts`). */
const PATH_TAINT_ROWS = 3000;
const PATH_TAINT_PAGE = 100;

/**
 * A file attached to a row is untrusted whatever the row's own parts look like: a document's text reaches the model as
 * text, and the file is named only by `fileIds`. Only the assistant's own rows (generated media) are left out.
 */
const attachmentTaint = (rows: ReadonlyArray<Pick<Doc<"messages">, "fileIds" | "message">>): DeviceTaintSource[] =>
    rows.some((row) => (row.fileIds?.length ?? 0) > 0 && (row.message as { role?: unknown } | undefined)?.role !== "assistant") ? ["files"] : [];

/**
 * What an agent that takes over from a thread has read when it is handed that thread's turns: the tool results and
 * attachments on its active path up to `leaf` (the handoff keeps only the text, but that text was written from them),
 * the summaries that folded older rows, and a takeover the thread itself was. A path longer than the read counts as
 * having read a page: the rows nobody looked at cannot be vouched for.
 */
export const threadPathTaint = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">, leaf: Doc<"messages">): Promise<DeviceTaintSource[]> => {
    const read: DeviceTaintSource[][] = [];
    let cursor: Doc<"messages"> | null = leaf;
    let rowsRead = 0;

    while (cursor && rowsRead < PATH_TAINT_ROWS) {
        const { next, rows } = await walkPath(ctx, threadId, cursor, { limit: PATH_TAINT_PAGE });

        read.push(computeTaint(rows.map((row) => row.message as { content?: unknown; role?: unknown })), attachmentTaint(rows));
        rowsRead += rows.length;
        cursor = next;
    }

    return mergeTaint(...read, await threadSummaryTaint(ctx, threadId), await threadHandoffTaint(ctx, threadId), cursor ? ["web"] : undefined);
};
