import { GOAL_CONTINUATION_AGENT } from "@neore/backend/chat/goals";

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
