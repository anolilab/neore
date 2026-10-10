/**
 * The `onLapse` of the reply `/chat/edit` enqueues (`lib/job-once.ts`): its
 * delivery died mid-run, and without this the edited prompt would sit there
 * with no reply and no error — or with a "generating…" row spinning forever.
 * The generation is NOT re-run (the job is claimed once); the user sees why
 * and can regenerate.
 *
 * Pending reply rows under the edited prompt are failed. When the delivery
 * died before writing any, a failed reply is added under the prompt, so the
 * error shows where the answer would have been.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { addMessagesHandler } from "../agent/messages";
import { patchRow } from "../lib/patch";

export const ABANDONED_REPLY_TEXT = "*The reply did not finish. Please try again.*";
const ABANDONED_REPLY_ERROR = "The reply stopped before it finished.";

export const failAbandonedEditReply = internalMutation
    .input({
        /** The job's claim key (added by `reapLapsedClaims`); unused, the prompt identifies the reply. */
        claimKey: v.optional(v.string()),
        /** The edited prompt the lost reply belonged to. */
        promptMessageId: v.id("messages"),
        threadId: v.id("threads"),
    })
    .output(v.object({ added: v.boolean(), failed: v.number() }))
    .mutation(async ({ args: { promptMessageId, threadId }, ctx }) => {
        const prompt = await ctx.db.get(promptMessageId);

        if (!prompt || prompt.threadId !== threadId) {
            return { added: false, failed: 0 };
        }

        // Replies to the prompt share or follow its `order`, and were written after it.
        const pendingRows = await ctx.db
            .query("messages")
            .withIndex("threadId_status_tool_order_stepOrder", (q) =>
                q.eq("threadId", threadId).eq("status", "pending").eq("tool", false).gte("order", prompt.order),
            )
            .collect();
        const pending = pendingRows.filter((row) => row._creationTime >= prompt._creationTime);

        for (const row of pending) {
            await patchRow(ctx.db, row, {
                error: ABANDONED_REPLY_ERROR,
                message: { content: [{ text: ABANDONED_REPLY_TEXT, type: "text" }], role: "assistant" },
                status: "failed",
                text: ABANDONED_REPLY_TEXT,
            });
        }

        if (pending.length > 0) {
            return { added: false, failed: pending.length };
        }

        // Nothing was written: answer the prompt with the error. A reply that
        // DID finish would have its own row, and then there is nothing to do.
        const answered = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId).eq("order", prompt.order))
            .collect();

        if (answered.some((row) => row._creationTime > prompt._creationTime && (row.message as { role?: string } | undefined)?.role === "assistant")) {
            return { added: false, failed: 0 };
        }

        await addMessagesHandler(ctx, {
            failPendingSteps: true,
            messages: [
                {
                    error: ABANDONED_REPLY_ERROR,
                    message: { content: [{ text: ABANDONED_REPLY_TEXT, type: "text" }], role: "assistant" },
                    status: "failed",
                },
            ],
            promptMessageId: promptMessageId as Id<"messages">,
            threadId,
            userId: prompt.userId ?? undefined,
        });

        return { added: true, failed: 0 };
    });
