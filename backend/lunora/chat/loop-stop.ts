/**
 * Writes the reply's closing line when the repeated-call guard ends a turn (`lib/repeated-call-guard.ts`). The line is an
 * assistant row under the thread's latest row, through the same write the agent's own rows use. A locked chat, a thread
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
    .input({ notice: v.string().max(NOTICE_MAX), threadId: v.id("threads"), userId: v.string() })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId);

        if (!thread || thread.userId !== args.userId || thread.deleted === true || isThreadLocked(thread)) {
            return false;
        }

        const leaf = thread.activeLeafMessageId ? await resolveLeafRow(ctx, thread._id, thread.activeLeafMessageId) : null;

        await addMessagesHandler(ctx, {
            failPendingSteps: false,
            ...(leaf && { parentMessageId: leaf._id }),
            messages: [{ message: { content: [{ text: args.notice, type: "text" }], role: "assistant" }, status: "success" }],
            threadId: args.threadId,
            userId: args.userId,
        });

        return true;
    });
