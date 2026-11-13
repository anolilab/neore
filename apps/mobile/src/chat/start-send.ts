import type { StartedChat } from "./chat-api";
import { ChatError, isClientMessageIdReused, isStartInProgress } from "./chat-api";

/** A send whose prompt went back to the composer: sending the same prompt again is a retry of it, under the same id. */
export interface HeldSend {
    clientMessageId: string;
    prompt: string;
}

/**
 * The `clientMessageId` of a send of `prompt`: the held one when the prompt is the one that went back to the composer (a
 * retry, which the server answers with the first send's ids if that one was saved), a new one for anything else.
 */
export const clientMessageIdFor = (held: HeldSend | null, prompt: string, newId: () => string): string => {
    if (held !== null && held.prompt === prompt) {
        return held.clientMessageId;
    }

    return newId();
};

/** How long a send whose first try is still being saved (409) is waited for: past the server's 2-minute lease, after which it is resumed. */
export const START_IN_PROGRESS_WAIT_MS = 150_000;

/** The pause between tries while the first one is still being saved. */
export const START_IN_PROGRESS_RETRY_MS = 3000;

/** The pauses before each retry of a send whose outcome is unknown (a timeout, a dropped connection, a 5xx). */
export const START_UNKNOWN_RETRY_DELAYS_MS = [1000, 3000] as const;

/**
 * A try's failure with no answer that it was refused: a timeout, a network failure, a 5xx, a body that would not parse.
 * The same send sent again cannot save twice, so it is retried.
 */
const isUnknownOutcome = (error: unknown): boolean => !(error instanceof ChatError && error.isRefusal) && !isStartInProgress(error);

/**
 * How long to wait before trying a failed send again, or `undefined` when it must not be: a 409 `chat_start_in_progress`
 * is waited out until {@link START_IN_PROGRESS_WAIT_MS}, a try with no answer is retried after each of
 * {@link START_UNKNOWN_RETRY_DELAYS_MS}, and anything else (a refusal, a 422 `client_message_id_reused`) ends it.
 */
const retryDelay = (error: unknown, { elapsedMs, unknownRetries }: { elapsedMs: number; unknownRetries: number }): number | undefined => {
    if (isClientMessageIdReused(error)) {
        return undefined;
    }

    if (isStartInProgress(error)) {
        return elapsedMs < START_IN_PROGRESS_WAIT_MS ? START_IN_PROGRESS_RETRY_MS : undefined;
    }

    return isUnknownOutcome(error) ? START_UNKNOWN_RETRY_DELAYS_MS[unknownRetries] : undefined;
};

/**
 * Starts the chat, trying the same send (`attempt`, which reuses one `clientMessageId`) again while that is safe:
 * - a 409 `chat_start_in_progress` (the first try is still being saved) is waited out, never shown as a failure;
 * - a try with no answer is sent again, up to the delays in {@link START_UNKNOWN_RETRY_DELAYS_MS};
 * - a refusal, a 422 `client_message_id_reused` and a stop (`signal`) end it at once.
 * A resend the server already took answers like a first send, with `duplicate: true` and that send's ids.
 */
export const startWithRetries = async ({
    attempt,
    now = Date.now,
    signal,
    sleep,
}: {
    attempt: () => Promise<StartedChat>;
    now?: () => number;
    signal?: AbortSignal;
    sleep: (ms: number) => Promise<void>;
}): Promise<StartedChat> => {
    const startedAt = now();
    const tryFrom = async (unknownRetries: number): Promise<StartedChat> => {
        try {
            return await attempt();
        } catch (error) {
            const delay = signal?.aborted ? undefined : retryDelay(error, { elapsedMs: now() - startedAt, unknownRetries });

            if (delay === undefined) {
                throw error;
            }

            await sleep(delay);

            if (signal?.aborted) {
                throw error;
            }

            return await tryFrom(isUnknownOutcome(error) ? unknownRetries + 1 : unknownRetries);
        }
    };

    return await tryFrom(0);
};

/**
 * The reply stream to follow after a start, or `undefined` when there is none (`streaming: false`): a resend whose reply
 * has no stream left to follow, which the chat's saved messages show instead. Following an absent token would fail and
 * call a delivered message's reply unfinished.
 */
export const replyStreamOf = (started: StartedChat): { streamId: string; streamToken: string } | undefined => {
    if (!started.streaming || started.streamId === null || started.streamToken === undefined) {
        return undefined;
    }

    return { streamId: started.streamId, streamToken: started.streamToken };
};
