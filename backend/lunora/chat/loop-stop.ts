/**
 * Writes the reply's closing line when the repeated-call guard ends a turn (`lib/repeated-call-guard.ts`). The line is an
 * assistant row under the reply's last row, at that row's order, so it groups with the reply it closes. It is written only
 * while that row is still the thread's active leaf: a message that moved the branch on takes no notice. A locked chat, a thread
 * that is not `userId`'s, or a deleted one gets nothing.
 */
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { resolveLeafRow } from "../agent/branch-rows";
import { addMessagesHandler } from "../agent/messages";
import { isThreadLocked } from "../lib/thread-lock";

/** Longer than any notice {@link loopNoticeText} writes, so a bad caller cannot store a page of text. */
const NOTICE_MAX = 400;

export const appendLoopStopNotice = internalMutation
    .input({ notice: v.string().max(NOTICE_MAX), replyRowId: v.string().max(200), threadId: v.id("threads"), userId: v.string() })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
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
    });
