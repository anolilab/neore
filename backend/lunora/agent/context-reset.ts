/**
 * Writes the context-reset divider (`context-reset-shape.ts`) at the end of a thread, through
 * `addMessagesHandler` so a branched thread gets the row under its active leaf.
 */
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { isThreadLocked } from "../lib/thread-lock";
import { leafRowOf } from "./agent-switch";
import { CONTEXT_RESET_KEY } from "./context-reset-shape";
import { addMessagesHandler } from "./messages";

/** Appends a divider to `threadId` when it is `userId`'s; does nothing otherwise. Returns whether it wrote one. */
export const appendContextReset = internalMutation
    .input({ threadId: v.id("threads"), userId: v.string() })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId);

        // A locked chat is written to only with the owner's unlock proof, which a scheduled run never has.
        if (!thread || thread.userId !== args.userId || thread.deleted === true || isThreadLocked(thread)) {
            return false;
        }

        // In a branched thread a system row is not hung under the displayed leaf by default, so it is named here.
        const leaf = thread.activeLeafMessageId ? await leafRowOf(ctx, thread) : null;

        await addMessagesHandler(ctx, {
            failPendingSteps: false,
            ...(leaf && { parentMessageId: leaf._id }),
            messages: [{ message: { content: "", role: "system" }, providerMetadata: { [CONTEXT_RESET_KEY]: { reason: "task_run" } }, status: "success" }],
            threadId: args.threadId,
            userId: args.userId,
        });

        return true;
    });
