import { ChatError, isClientMessageIdReused, isStartInProgress } from "./chat-api";
import { GIVE_BACK_SEPARATOR } from "./start-send";

/**
 * The composer after a send the server never accepted: the prompt goes back, ahead of anything typed since, so a
 * failed token request or a refused start never loses it.
 */
export const draftAfterUnsent = (current: string, prompt: string): string => {
    if (current.trim() === "") {
        return prompt;
    }

    return `${prompt}${GIVE_BACK_SEPARATOR}${current}`;
};

/**
 * The composer after a failed send, and whether its prompt landed ahead of text typed meanwhile. Merged, the next press
 * of Send still sends the prompt alone under its held id and keeps the rest for the next message (`planSend`); the
 * notice says so ({@link failedSendMessage}).
 */
export const giveBackDraft = (current: string, prompt: string): { draft: string; isMerged: boolean } => {
    const draft = draftAfterUnsent(current, prompt);

    return { draft, isMerged: draft !== prompt };
};

/** The rows after a send the server never accepted: its local prompt and reply rows go, since no read will ever confirm them. */
export const withoutUnsentRows = <T extends { id: string }>(rows: T[], ids: ReadonlyArray<string>): T[] => rows.filter((row) => !ids.includes(row.id));

/** How far a send got: nothing went out yet, the start request went out, or the server answered with the started chat. */
export type SendStage = "accepted" | "before-request" | "requested";

/**
 * What a failed send does with its prompt. `accepted`: the chat started; only the reply failed. `give-back`: anything
 * else, whether or not the server took it. The prompt returns to the composer with its `clientMessageId` kept
 * ({@link shouldKeepClientMessageId}), so sending it again is the same send: the server saves it once and answers a resend of
 * a saved one with its ids (`duplicate: true`).
 */
export const failedSendOutcome = (stage: SendStage): "accepted" | "give-back" => {
    if (stage === "accepted") {
        return "accepted";
    }

    return "give-back";
};

/** Whether a prompt given back keeps its `clientMessageId` for a resend: not when the server said the id belongs to another request. */
export const shouldKeepClientMessageId = (error: unknown): boolean => !isClientMessageIdReused(error);

/** Ends the message of a send that may have reached the server: its prompt is back, and sending it again is safe. */
export const MAY_HAVE_BEEN_SENT_NOTICE = "It may have been sent: it is back in the message box, and sending it again will not send it twice.";

/**
 * The same, when the prompt went back ahead of text typed meanwhile: Send sends it again on its own (`planSend`), and the
 * text typed meanwhile stays for the next message. Editing the prompt itself makes it a new message.
 */
export const MAY_HAVE_BEEN_SENT_MERGED_NOTICE
    = "It may have been sent: it is back at the top of the message box. Send sends it again on its own, so it is not saved twice, and keeps what you typed after it for your next message.";

/** A send whose first try was still being saved when the wait ran out. */
export const STILL_SENDING_MESSAGE = `The message is still being sent. ${MAY_HAVE_BEEN_SENT_NOTICE}`;

/**
 * The error shown for a failed send. One that may have reached the server says that sending it again is safe, and, when
 * it went back ahead of text typed meanwhile, that Send sends it on its own first.
 */
export const failedSendMessage = (error: unknown, stage: SendStage, { isMerged = false }: { isMerged?: boolean } = {}): string => {
    const notice = isMerged ? MAY_HAVE_BEEN_SENT_MERGED_NOTICE : MAY_HAVE_BEEN_SENT_NOTICE;

    if (isStartInProgress(error)) {
        return `The message is still being sent. ${notice}`;
    }

    const message = error instanceof Error ? error.message : "Could not send.";
    const isPossiblySent = stage === "requested" && !(error instanceof ChatError && error.isRefusal);

    return isPossiblySent ? `${message} ${notice}` : message;
};
