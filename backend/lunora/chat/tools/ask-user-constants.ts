/**
 * The `askUser` tool's name, limits and types (`ask-user.ts`), apart from the
 * tool itself so the run, claim and procedure code can import them without
 * loading the agent client.
 */
export const ASK_USER_TOOL_NAME = "askUser";

export const ASK_USER_QUESTION_MAX = 1000;

export const ASK_USER_CHOICE_MAX = 200;

export const ASK_USER_MAX_CHOICES = 6;

/** The longest free-text answer the user may send back. */
export const ASK_USER_ANSWER_MAX = 4000;

/** What the model is told when the user closes the question without answering. */
export const ASK_USER_DISMISSED_REASON = "The user dismissed the question without answering. Continue with your best judgement, or ask differently.";

export interface AskUserInput {
    choices?: string[];
    question: string;
}

export type AskUserOutput = { answer: string; answered: true } | { answered: false; message: string };
