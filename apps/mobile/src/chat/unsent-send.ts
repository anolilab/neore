import { ChatError } from "./chat-api";

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
 * What a failed send does with its prompt. `give-back`: the server provably never took it (the failure came before the
 * request, or the gateway answered with a refusal), so it returns to the composer and its rows go. `possibly-sent`: the
 * request went out and no answer says whether the chat started (a timeout, a dropped connection, a body that would not
 * parse), so giving it back at once would invite a second copy; it is held and checked for (`possibly-sent.ts`).
 * `accepted`: the chat started; only the reply failed.
 */
export const failedSendOutcome = (stage: SendStage, error: unknown): "accepted" | "give-back" | "possibly-sent" => {
    if (stage === "requested") {
        return error instanceof ChatError && error.isRefusal ? "give-back" : "possibly-sent";
    }

    return stage === "accepted" ? "accepted" : "give-back";
};

/** The end of the error for a send that may have reached the server; a found or given-back prompt clears it. */
export const POSSIBLY_SENT_NOTICE = "The message may have been sent. It is being checked; if it did not arrive, it goes back to the message box.";

/** Shown when a possibly-sent prompt was not found on the server and is back in the composer. */
export const UNSENT_GIVEN_BACK_MESSAGE = "The message may not have been sent. It is back in the message box; send it again if it does not show up.";

/** The error shown for a failed send. One that may have reached the server says it is being checked. */
export const failedSendMessage = (error: unknown, outcome: ReturnType<typeof failedSendOutcome>): string => {
    const message = error instanceof Error ? error.message : "Could not send.";

    return outcome === "possibly-sent" ? `${message} ${POSSIBLY_SENT_NOTICE}` : message;
};
