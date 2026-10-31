/**
 * The reviewer: ONE utility-model call over the goal and a round's transcript.
 * Shared by the interactive review job (`execute.ts`) and a headless run
 * (`headless.ts`) so both read the verdict the same way.
 */
import { generateText } from "ai";

import { readMessageCost } from "../../agent/message-cost";
import type { ServiceFetch } from "../../lib/services";
import { buildGoalReviewPrompt, GOAL_REVIEWER_SYSTEM_PROMPT, type GoalVerdict, parseGoalVerdict } from "./logic";

const REVIEWER_TIMEOUT_MS = 60_000;

/** One reviewer call. Throws when the model cannot be reached; the caller ends the goal rather than continue blind. */
export const reviewRound = async (input: {
    gateway: ServiceFetch;
    goal: string;
    round: number;
    threadId: string;
    transcript: string;
    userId: string;
}): Promise<GoalVerdict & { costMicrodollars: number }> => {
    const { getUtilityModel } = await import("../../lib/utility-model");
    const model = await getUtilityModel(input.gateway, { threadId: input.threadId, userId: input.userId });
    const result = await generateText({
        abortSignal: AbortSignal.timeout(REVIEWER_TIMEOUT_MS),
        model,
        prompt: buildGoalReviewPrompt(input),
        system: GOAL_REVIEWER_SYSTEM_PROMPT,
        temperature: 0,
    });

    return { ...parseGoalVerdict(result.text), costMicrodollars: readMessageCost(result.providerMetadata)?.microdollars ?? 0 };
};
