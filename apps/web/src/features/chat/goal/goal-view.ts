import { GOAL_CONTINUATION_AGENT, parseGoalReviewNote } from "@neore/backend/chat/goals";

import type { UIMessage } from "@/lib/agent";

/** The reviewer's verdict on one round, as `getThreadGoal` returns it. */
export interface GoalVerdictView {
    met: boolean;
    order?: number;
    reason: string;
    round: number;
}

/** Whether a message is the instruction a goal saved to open a round, which nobody typed. */
export const isGoalInstruction = (message: Pick<UIMessage, "agentName" | "role">): boolean =>
    message.role === "user" && message.agentName === GOAL_CONTINUATION_AGENT;

/** The thread's messages without the goal's own instructions. The same array when there are none. */
export const withoutGoalInstructions = (messages: UIMessage[]): UIMessage[] =>
    messages.some((message) => isGoalInstruction(message)) ? messages.filter((message) => !isGoalInstruction(message)) : messages;

/**
 * Where each verdict is shown: under the last assistant message of the turn it judged. A verdict whose turn is
 * not loaded (an older page, a deleted reply) goes under the last message, so it is never lost.
 */
export const anchorVerdicts = (
    messages: ReadonlyArray<Pick<UIMessage, "id" | "order" | "role">>,
    verdicts: ReadonlyArray<GoalVerdictView>,
): Map<string, GoalVerdictView[]> => {
    const anchors = new Map<string, GoalVerdictView[]>();
    const lastId = messages.at(-1)?.id;

    for (const verdict of verdicts) {
        const target = messages.findLast((message) => message.role === "assistant" && message.order === verdict.order)?.id ?? lastId;

        if (target !== undefined) {
            anchors.set(target, [...(anchors.get(target) ?? []), verdict]);
        }
    }

    return anchors;
};

const messageText = (message: Pick<UIMessage, "parts" | "text">): string =>
    message.text ?? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/**
 * The reviewer's reasons the goal's instruction rows carry, each keyed by the message it follows (the last
 * one that is not itself an instruction): they are shown there as "Review: …" notes, not as messages.
 */
export const goalReviewNotes = (messages: ReadonlyArray<Pick<UIMessage, "agentName" | "id" | "parts" | "role" | "text">>): Map<string, string[]> => {
    const notes = new Map<string, string[]>();
    let previousId: string | undefined;

    for (const message of messages) {
        if (!isGoalInstruction(message)) {
            previousId = message.id;
            continue;
        }

        const reason = previousId === undefined ? undefined : parseGoalReviewNote(messageText(message))?.reason;

        if (previousId !== undefined && reason) {
            notes.set(previousId, [...(notes.get(previousId) ?? []), reason]);
        }
    }

    return notes;
};

/**
 * The verdicts that no instruction row already shows. A "Review: …" note follows the reply of the round it judged,
 * so an unmet verdict is dropped only when a note follows the reply it is anchored to (matched by round, never by
 * wording: a final verdict may repeat an earlier reason and still has no note of its own).
 */
export const withoutNotedVerdicts = (
    messages: ReadonlyArray<Pick<UIMessage, "id" | "order" | "role">>,
    verdicts: ReadonlyArray<GoalVerdictView>,
    notes: ReadonlyMap<string, string[]>,
): GoalVerdictView[] =>
    verdicts.filter((verdict) => {
        if (verdict.met) {
            return true;
        }

        const reply = messages.findLast((message) => message.role === "assistant" && message.order === verdict.order);

        return reply === undefined || !notes.has(reply.id);
    });
