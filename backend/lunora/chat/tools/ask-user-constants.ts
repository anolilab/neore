/**
 * The `askUser` tool's name, limits and types (`ask-user.ts`), apart from the
 * tool itself so the run, claim and procedure code can import them without
 * loading the agent client.
 */
export const ASK_USER_TOOL_NAME = "askUser";

export const ASK_USER_QUESTION_MAX = 1000;

export const ASK_USER_CHOICE_MAX = 200;

export const ASK_USER_MAX_CHOICES = 6;

/** Most questions one `askUser` call may ask in its single card. */
export const ASK_USER_MAX_QUESTIONS = 4;

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

/** The largest image an answer may carry: a provider takes at most 5 MB of base64 per image, which is 3.75 MiB of bytes. */
export const ASK_USER_IMAGE_MAX_BYTES = 3_932_160;

/** Every file of one answer together, in bytes: the bytes are held in memory for the one model call. */
export const ASK_USER_FILES_TOTAL_MAX_BYTES = 20 * 1024 * 1024;

/** One question of a multi-question call. */
export interface AskUserQuestion {
    choices?: string[];
    /** `true` lets the user pick several choices; absent or `false` picks one. */
    multiSelect?: boolean;
    question: string;
}

/**
 * Either the legacy form (`question` + `choices`) or `questions`, never both: the tool's schema refuses a call that
 * carries both or neither.
 */
export interface AskUserInput {
    choices?: string[];
    question?: string;
    questions?: AskUserQuestion[];
}

/** The user's reply to one question of a multi-question call. */
export interface AskUserQuestionAnswer {
    /** The question's text, repeated so the answer reads on its own. */
    question: string;
    /** The choices picked, in the question's order; empty when the user only typed a note. */
    selected: string[];
    note?: string;
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

export type AskUserOutput =
    | { answer: string; answered: true; attachedFiles?: AskUserAttachedFile[]; unreadFiles?: string[] }
    | { answered: true; answers: AskUserQuestionAnswer[]; attachedFiles?: AskUserAttachedFile[]; unreadFiles?: string[] }
    | { answered: false; message: string };
