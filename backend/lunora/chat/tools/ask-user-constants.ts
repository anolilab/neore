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

/** Most files one answer may carry. */
export const ASK_USER_MAX_FILES = 4;

/** Types an answer may carry: the model reads them in the answered tool's result (images and PDFs). */
export const ASK_USER_FILE_TYPES: ReadonlyArray<string> = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"];

/** The largest file an answer may carry, in bytes. */
export const ASK_USER_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Every file of one answer together, in bytes: the bytes are held in memory for the one model call. */
export const ASK_USER_FILES_TOTAL_MAX_BYTES = 20 * 1024 * 1024;

export interface AskUserInput {
    choices?: string[];
    question: string;
}

/** A file the user attached to the answer, read from storage for one model call. */
export interface AskUserFile {
    /** Base64, without a data URL prefix. */
    data: string;
    filename: string;
    mediaType: string;
}

/** The files an answer carried, by name and type only; their bytes never reach the stored output. */
export interface AskUserAttachedFile {
    filename: string;
    mediaType: string;
}

export type AskUserOutput = { answer: string; answered: true; attachedFiles?: AskUserAttachedFile[] } | { answered: false; message: string };
