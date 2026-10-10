/**
 * Answering an `askUser` question (`chat/tools/ask-user.ts`) and resuming the
 * run that asked it.
 *
 * The question is a `tool-approval-request` for the `askUser` call, so this is
 * `respondToToolApproval` with an answer instead of a decision: the same owner
 * check, the same single `pending -> approved|denied` transition on the run's
 * `toolApprovalRuns` snapshot, and the same continuation
 * (`continueAfterToolApproval`, on the jobs queue). An answer approves the call
 * and becomes its tool result; dismissing denies it with a reason the model
 * reads. A repeat call returns the first call's stream.
 */
import { v } from "lunorash/server";

import { authMutation, rateLimit } from "../lib/crpc";
import { claimAskUserAnswer } from "./lib/ask-user-claim";
import { resumeClaimedRun } from "./lib/tool-approval-resume";
import { ASK_USER_ANSWER_MAX, ASK_USER_DISMISSED_REASON } from "./tools/ask-user-constants";

export const answerAskUser = authMutation
    .use(rateLimit("chat/stream"))
    .input({
        /** `null` dismisses the question without answering. */
        answer: v.union(
            v.string().check((value) => value.length <= ASK_USER_ANSWER_MAX * 2, { message: "Answer too long" }),
            v.null(),
        ),
        approvalId: v.string().check((value) => value.length > 0 && value.length <= 256, { message: "Invalid approval id" }),
        threadId: v.id("threads"),
    })
    .output(v.object({ alreadyResolved: v.boolean(), streamId: v.union(v.string(), v.null()) }))
    .mutation(async ({ args: { answer, approvalId, threadId }, ctx }) => {
        const claim = await claimAskUserAnswer(ctx, {
            approvalId,
            callerId: ctx.user.userId,
            reply: answer === null ? { kind: "dismiss" } : { answer, kind: "answer" },
            threadId,
        });

        if (claim.kind === "already-resolved") {
            return { alreadyResolved: true, streamId: claim.streamId };
        }

        const streamId = await resumeClaimedRun(ctx, {
            approvalId,
            approved: claim.answer !== undefined,
            config: claim.config,
            ownerId: claim.ownerId,
            runId: claim.runId,
            threadId,
            ...(claim.answer === undefined ? { denyReason: ASK_USER_DISMISSED_REASON } : { answer: claim.answer }),
        });

        ctx.log.event("chat.answer_ask_user", { alreadyResolved: false, dismissed: claim.answer === undefined, resumed: streamId !== null });

        return { alreadyResolved: false, streamId };
    });
