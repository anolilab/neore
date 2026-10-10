/**
 * Ask User tool.
 *
 * The agent asks the user a question mid-run and waits for the answer. It rides
 * the tool-approval round trip rather than a machinery of its own:
 *
 * - The tool ALWAYS needs approval, so calling it stops the step with a
 *   `tool-approval-request`, and the run records its `toolApprovalRuns`
 *   snapshot exactly as an `ask` tool does (`finishRun`).
 * - The user answers through `chat_ask_user.answerAskUser`, never through
 *   `respondToToolApproval` (which refuses this tool): the answer is claimed
 *   like an approval and the run resumes via `continueAfterToolApproval`.
 * - The continuation swaps in {@link createAnsweredAskUserTool}, whose execute
 *   returns the answer, so the approved call's tool result IS the answer.
 *   Dismissing denies the call with a reason the model reads.
 *
 * Headless runs never see it (`tool-permissions.ts`: nobody is there to answer).
 * Its name and limits live in `ask-user-constants.ts`, which the run and claim
 * code import without pulling in the agent client.
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import type { AskUserInput, AskUserOutput } from "./ask-user-constants";
import { ASK_USER_CHOICE_MAX, ASK_USER_MAX_CHOICES, ASK_USER_QUESTION_MAX } from "./ask-user-constants";

const inputSchema = z
    .object({
        choices: z
            .array(z.string().min(1).max(ASK_USER_CHOICE_MAX))
            .max(ASK_USER_MAX_CHOICES)
            .optional()
            .meta({ description: "Short suggested answers, shown as buttons. The user can always type their own answer instead." }),
        question: z.string().min(1).max(ASK_USER_QUESTION_MAX).meta({ description: "One clear question for the user" }),
    })
    .strict();

const DESCRIPTION = `Ask the user a question and wait for their answer before continuing.
Use it only when you cannot proceed well without information or a decision only the user has — an ambiguous request, a choice between materially different options, a missing detail. Do not use it for small talk or to confirm what the user already said.
- question: one clear, self-contained question.
- choices: optional short suggested answers (up to ${String(ASK_USER_MAX_CHOICES)}); the user may still answer in their own words.
The run pauses until the user answers; the tool result is their answer. If they dismiss the question, carry on with your best judgement.`;

/**
 * The registered tool. Its execute runs only if something approves the call
 * WITHOUT an answer — which `respondToToolApproval` refuses — so it reports
 * that no answer arrived rather than inventing one.
 */
const askUserTool = createTool<AskUserInput, AskUserOutput, ToolContext>({
    description: DESCRIPTION,
    execute: async () => {
        return { answered: false, message: "No answer was given." };
    },
    inputSchema,
    needsApproval: true,
    title: "Ask User",
});

/** The same tool for one resumed run, answering with `answer`. */
export const createAnsweredAskUserTool = (answer: string) =>
    createTool<AskUserInput, AskUserOutput, ToolContext>({
        description: DESCRIPTION,
        execute: async () => {
            return { answer, answered: true };
        },
        inputSchema,
        needsApproval: true,
        title: "Ask User",
    });

export type { AskUserInput, AskUserOutput } from "./ask-user-constants";
export { ASK_USER_ANSWER_MAX, ASK_USER_DISMISSED_REASON, ASK_USER_TOOL_NAME } from "./ask-user-constants";

export default askUserTool;
