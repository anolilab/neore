/**
 * Claiming an answer to an `askUser` question — `answerAskUser`'s core, kept
 * apart from the procedure so it can be driven against a real schema in tests.
 *
 * It is `claimToolApproval` plus one rule each way: the claimed request must be
 * an `askUser` call (an approval for any other tool is `respondToToolApproval`'s
 * job, and that procedure refuses `askUser` in turn), and an answer must be
 * non-empty text within {@link ASK_USER_ANSWER_MAX}. A throw rolls the claim back.
 */
import { LunoraError } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { ASK_USER_ANSWER_MAX, ASK_USER_TOOL_NAME } from "../tools/ask-user-constants";
import type { ClaimResult } from "./tool-approval-claim";
import { claimToolApproval } from "./tool-approval-claim";

export type AskUserReply = { answer: string; kind: "answer" } | { kind: "dismiss" };

/** The answer as it reaches the model: trimmed, or `undefined` when it is empty or too long. */
export const normalizeAskUserAnswer = (answer: string): string | undefined => {
    const trimmed = answer.trim();

    return trimmed.length > 0 && trimmed.length <= ASK_USER_ANSWER_MAX ? trimmed : undefined;
};

export const claimAskUserAnswer = async (
    ctx: Pick<MutationCtx, "db">,
    args: { approvalId: string; callerId: string; reply: AskUserReply; threadId: Id<"threads"> },
): Promise<ClaimResult & { answer?: string }> => {
    const { approvalId, callerId, reply, threadId } = args;
    const answer = reply.kind === "answer" ? normalizeAskUserAnswer(reply.answer) : undefined;

    if (reply.kind === "answer" && answer === undefined) {
        throw new LunoraError("BAD_REQUEST", `Answer with 1 to ${String(ASK_USER_ANSWER_MAX)} characters`);
    }

    const claim = await claimToolApproval(ctx, { approvalId, callerId, decision: reply.kind === "answer" ? "approve" : "deny", threadId });

    if (claim.kind === "claimed" && claim.toolName !== ASK_USER_TOOL_NAME) {
        throw new LunoraError("BAD_REQUEST", "This request is not a question");
    }

    return answer === undefined ? claim : { ...claim, answer };
};
