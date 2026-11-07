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
import type { AskUserInput, AskUserQuestionAnswer } from "../tools/ask-user-constants";
import { ASK_USER_ANSWER_MAX, ASK_USER_TOOL_NAME } from "../tools/ask-user-constants";
import type { ClaimResult } from "./tool-approval-claim";
import { claimToolApproval, findPendingRequestOnLatestTurn } from "./tool-approval-claim";

/** What the client sent for one question of a multi-question card, by position. */
export interface AskUserQuestionReply {
    note?: string;
    selected: string[];
}

export type AskUserReply = { answer: string; kind: "answer" } | { answers: AskUserQuestionReply[]; kind: "answers" } | { kind: "dismiss" };

/** The answer as it reaches the model: trimmed, or `undefined` when it is empty or too long. */
export const normalizeAskUserAnswer = (answer: string): string | undefined => {
    const trimmed = answer.trim();

    return trimmed.length > 0 && trimmed.length <= ASK_USER_ANSWER_MAX ? trimmed : undefined;
};

/** A question's choices as the card shows them: trimmed, non-blank, each once, in the model's order. */
const canonicalChoices = (choices: ReadonlyArray<string> | undefined): string[] => {
    const trimmed = (choices ?? []).map((choice) => choice.trim()).filter((choice) => choice.length > 0);

    return [...new Set(trimmed)];
};

/**
 * The replies of a multi-question card checked against the questions the model asked, and joined to them: one reply
 * per question, every selection one of that question's choices (one at most unless it is multi-select), and each
 * question answered by a selection or a note. Anything else is a malformed request, not a partial answer.
 */
export const resolveQuestionAnswers = (
    questions: NonNullable<AskUserInput["questions"]>,
    replies: ReadonlyArray<AskUserQuestionReply>,
): AskUserQuestionAnswer[] => {
    if (replies.length !== questions.length) {
        throw new LunoraError("BAD_REQUEST", "Answer every question");
    }

    return questions.map((asked, index) => {
        const reply = replies[index] ?? { selected: [] };
        // The choices as the card shows them (trimmed, each once), so a pick of a shown choice always matches.
        const selected = canonicalChoices(asked.choices).filter((choice) => reply.selected.includes(choice));

        // A pick that is repeated or unknown makes the counts differ.
        if (selected.length !== reply.selected.length) {
            throw new LunoraError("BAD_REQUEST", "A selected choice is not one of the question's choices");
        }

        if (selected.length > 1 && asked.multiSelect !== true) {
            throw new LunoraError("BAD_REQUEST", "This question takes one choice");
        }

        const note = reply.note?.trim();

        if (note !== undefined && note.length > ASK_USER_ANSWER_MAX) {
            throw new LunoraError("BAD_REQUEST", `Notes take up to ${String(ASK_USER_ANSWER_MAX)} characters`);
        }

        if (selected.length === 0 && !note) {
            throw new LunoraError("BAD_REQUEST", "Answer every question with a choice or a note");
        }

        return { question: asked.question, selected, ...(note && { note }) };
    });
};

export const claimAskUserAnswer = async (
    ctx: Pick<MutationCtx, "db">,
    args: { approvalId: string; callerId: string; reply: AskUserReply; threadId: Id<"threads">; unlockProof?: string | null },
): Promise<ClaimResult & { answer?: string; answers?: AskUserQuestionAnswer[] }> => {
    const { approvalId, callerId, reply, threadId, unlockProof } = args;
    const answer = reply.kind === "answer" ? normalizeAskUserAnswer(reply.answer) : undefined;

    if (reply.kind === "answer" && answer === undefined) {
        throw new LunoraError("BAD_REQUEST", `Answer with 1 to ${String(ASK_USER_ANSWER_MAX)} characters`);
    }

    const claim = await claimToolApproval(ctx, {
        approvalId,
        callerId,
        decision: reply.kind === "dismiss" ? "deny" : "approve",
        threadId,
        unlockProof,
    });

    if (claim.kind === "claimed" && claim.toolName !== ASK_USER_TOOL_NAME) {
        throw new LunoraError("BAD_REQUEST", "This request is not a question");
    }

    if (claim.kind !== "claimed" || reply.kind === "dismiss") {
        return claim;
    }

    // The form of the reply must be the form of the question: one question takes text, several take a list.
    // A throw here rolls the claim back, like the checks above.
    const pending = await findPendingRequestOnLatestTurn(ctx, threadId, approvalId);
    const questions = (pending?.input as AskUserInput | undefined)?.questions;

    if (reply.kind === "answers") {
        if (!questions) {
            throw new LunoraError("BAD_REQUEST", "This question takes a text answer");
        }

        return { ...claim, answers: resolveQuestionAnswers(questions, reply.answers) };
    }

    if (questions) {
        throw new LunoraError("BAD_REQUEST", "These questions take a list of answers");
    }

    return { ...claim, answer: answer as string };
};
