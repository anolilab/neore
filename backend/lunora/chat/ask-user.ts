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
import { MAX_LENGTH } from "../lib/validators";
import { LunoraError, v } from "lunorash/server";

import { authMutation, rateLimit } from "../lib/crpc";
import { isThreadLocked } from "../lib/thread-lock";
import { claimAskUserAnswer } from "./lib/ask-user-claim";
import { resumeClaimedRun } from "./lib/tool-approval-resume";
import { ASK_USER_ANSWER_MAX, ASK_USER_DISMISSED_REASON, ASK_USER_MAX_FILES } from "./tools/ask-user-constants";

export const answerAskUser = authMutation
    .use(rateLimit("chat/stream"))
    .input({
        /** `null` dismisses the question without answering. */
        answer: v.union(
            v.string().check((value) => value.length <= ASK_USER_ANSWER_MAX * 2, { message: "Answer too long" }),
            v.null(),
        ),
        approvalId: v.string().check((value) => value.length > 0 && value.length <= 256, { message: "Invalid approval id" }),
        /** Files to answer with, checked by the continuation as the owner (`lib/ask-user-files.ts`); none on a dismiss. */
        fileIds: v.optional(v.array(v.string().max(MAX_LENGTH.id)).check((value) => value.length <= ASK_USER_MAX_FILES, { message: "Too many files" })),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.object({ alreadyResolved: v.boolean(), streamId: v.union(v.string(), v.null()) }))
    .mutation(async ({ args: { answer, approvalId, fileIds, threadId, unlockProof }, ctx }) => {
        // A malformed id is not a file: it is dropped here, so it cannot fail the run that answers the question.
        const answerFileIds = (fileIds ?? []).filter((id) => ctx.db.normalizeId("chatFiles", id) !== null);

        // The run resumes later without the lock's proof, so the files could not be read there: refused now, not dropped.
        // A dismissal uses no files, so it is never refused for them.
        if (answer !== null && answerFileIds.length > 0) {
            const thread = await ctx.db.get("threads", threadId);

            // Only the owner learns the lock: a stranger gets the same answer as for any other thread, from the claim below.
            if (thread && thread.userId === ctx.user.userId && isThreadLocked(thread)) {
                throw new LunoraError("FORBIDDEN", "Files cannot be attached to an answer in a locked chat.");
            }
        }

        const claim = await claimAskUserAnswer(ctx, {
            approvalId,
            callerId: ctx.user.userId,
            reply: answer === null ? { kind: "dismiss" } : { answer, kind: "answer" },
            threadId,
            unlockProof,
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
            ...(claim.answer === undefined
                ? { denyReason: ASK_USER_DISMISSED_REASON }
                : { answer: claim.answer, ...(answerFileIds.length > 0 && { answerFileIds }) }),
        });

        ctx.log.event("chat.answer_ask_user", { alreadyResolved: false, dismissed: claim.answer === undefined, resumed: streamId !== null });

        return { alreadyResolved: false, streamId };
    });
