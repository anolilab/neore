import { ChatError, isClientMessageIdReused, isStartInProgress } from "./chat-api";

/**
 * The composer after a send the server never accepted: the prompt goes back, ahead of anything typed since, so a
 * failed token request or a refused start never loses it.
 */
export const draftAfterUnsent = (current: string, prompt: string): string => {
    if (current.trim() === "") {
        return prompt;
    }

    return `${prompt}\n\n${current}`;
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

/** A send whose first try was still being saved when the wait ran out. */
export const STILL_SENDING_MESSAGE = `The message is still being sent. ${MAY_HAVE_BEEN_SENT_NOTICE}`;

/** The error shown for a failed send. One that may have reached the server says it is safe to send again. */
export const failedSendMessage = (error: unknown, stage: SendStage): string => {
    if (isStartInProgress(error)) {
        return STILL_SENDING_MESSAGE;
    }

    const message = error instanceof Error ? error.message : "Could not send.";
    const isPossiblySent = stage === "requested" && !(error instanceof ChatError && error.isRefusal);

    return isPossiblySent ? `${message} ${MAY_HAVE_BEEN_SENT_NOTICE}` : message;
};
