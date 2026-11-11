/**
 * Writes the reply's closing line when the repeated-call guard ends a turn (`lib/repeated-call-guard.ts`). The line is an
 * assistant row under the reply's last row, at that row's order, so it groups with the reply it closes. It is written only
 * while that row is still the thread's active leaf: a message that moved the branch on takes no notice. A locked chat, a thread
 * that is not `userId`'s, or a deleted one gets nothing.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { type ActionCtx, internalMutation, type MutationCtx } from "../_generated/server";
import { resolveLeafRow } from "../agent/branch-rows";
import { addMessagesHandler } from "../agent/messages";
import { streamLogger } from "../lib/logger";
import { isThreadLocked } from "../lib/thread-lock";
import { type LoopFinding, loopNoticeText } from "./lib/repeated-call-guard";

/** Longer than any notice {@link loopNoticeText} writes, so a bad caller cannot store a page of text. */
const NOTICE_MAX = 400;

/**
 * Writes the closing line of a run the repeated-call guard ended. A runner calls it only after its reply finished normally: a stopped,
 * paused or replaced run takes none. The line goes under the reply's last saved row. A refused or failed write is logged with the run's
 * stream id and never fails the run.
 */
export const writeLoopStopNotice = async (
    ctx: Pick<ActionCtx, "runMutation">,
    args: {
        finding: LoopFinding | undefined;
        savedMessages: ReadonlyArray<{ _id: string }> | undefined;
        streamId: string;
        threadId: string;
        userId: string;
    },
): Promise<void> => {
    const replyRowId = args.savedMessages?.at(-1)?._id;

    if (args.finding === undefined || replyRowId === undefined) {
        return;
    }

    await ctx
        .runMutation(internal.chat.loop_stop.appendLoopStopNotice, {
            notice: loopNoticeText(args.finding),
            replyRowId: String(replyRowId),
            threadId: args.threadId as Id<"threads">,
            userId: args.userId,
        })
        .catch((error: unknown) => {
            streamLogger.warn(`[LoopStop] Could not write the repeated-call notice for run ${args.streamId}:`, error);
        });
};

/**
 * Writes the line if the thread may take it: the owner's, not locked or deleted, and the reply still the active leaf. Returns whether
 * it was written. Plain function so a test can drive it over `ctx.db`; the internal mutation below is the only caller in production.
 */
export const appendLoopStopNoticeRow = async (
    ctx: MutationCtx,
    args: { notice: string; replyRowId: string; threadId: Id<"threads">; userId: string },
): Promise<boolean> => {
    const thread = await ctx.db.get("threads", args.threadId);

    if (!thread || thread.userId !== args.userId || thread.deleted === true || isThreadLocked(thread)) {
        return false;
    }

    const leaf = thread.activeLeafMessageId ? await resolveLeafRow(ctx, thread._id, thread.activeLeafMessageId) : null;

    // The reply's last row must still be the active leaf: otherwise another message has moved the branch, and the notice would
    // land under the wrong reply.
    if (!leaf || String(leaf._id) !== args.replyRowId) {
        return false;
    }

    await addMessagesHandler(ctx, {
        failPendingSteps: false,
        messages: [{ message: { content: [{ text: args.notice, type: "text" }], role: "assistant" }, status: "success" }],
        overrideOrder: leaf.order,
        parentMessageId: leaf._id,
        threadId: args.threadId,
        userId: args.userId,
    });

    return true;
};

export const appendLoopStopNotice = internalMutation
    .input({ notice: v.string().max(NOTICE_MAX), replyRowId: v.string().max(200), threadId: v.id("threads"), userId: v.string() })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => await appendLoopStopNoticeRow(ctx, args));
