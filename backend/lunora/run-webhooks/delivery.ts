/**
 * One signed POST of a run webhook event to the user's URL.
 *
 * What the answer tells the user is limited on purpose: the status code and the
 * time taken. The response body is cancelled unread, so a receiver (or a host it
 * redirects to) cannot push text into the app's responses. Redirects are not
 * followed (`redirect: "manual"`), so a 3xx is a failed delivery, reported as one.
 */
import { fetchWithTimeout } from "../chat/tools/utilities";
import { type RunWebhookEvent, runWebhookUrlProblem, signRunWebhook } from "./payload";

/** How long a receiver may take to answer. Part 2's retries reuse it per attempt. */
export const RUN_WEBHOOK_TIMEOUT_MS = 10_000;

export type RunWebhookSend = (url: string, init: RequestInit) => Promise<Response>;

export interface RunWebhookAttempt {
    durationMs: number;
    error?: string;
    ok: boolean;
    status?: number;
}

const defaultSend: RunWebhookSend = async (url, init) => await fetchWithTimeout(url, init, RUN_WEBHOOK_TIMEOUT_MS);

export const deliverRunWebhook = async ({
    event,
    now,
    secret,
    send = defaultSend,
    url,
}: {
    event: RunWebhookEvent;
    /** Milliseconds. The signature's timestamp is taken from it, so it must be the time of this attempt. */
    now: number;
    secret: string;
    send?: RunWebhookSend;
    url: string;
}): Promise<RunWebhookAttempt> => {
    const problem = runWebhookUrlProblem(url);

    if (problem !== null) {
        return { durationMs: 0, error: problem, ok: false };
    }

    const body = JSON.stringify(event);
    const signature = await signRunWebhook(secret, body, Math.floor(now / 1000));
    const started = Date.now();

    try {
        const response = await send(url, {
            body,
            headers: {
                "content-type": "application/json",
                "user-agent": "Neore-Webhooks",
                "x-neore-event": event.type,
                "x-neore-event-id": event.id,
                ...signature,
            },
            method: "POST",
            redirect: "manual",
        });

        // The body is not read; cancelling it frees the socket the answer holds.
        await response.body?.cancel().catch(() => undefined);

        return {
            durationMs: Date.now() - started,
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
        };
    } catch (error) {
        return { durationMs: Date.now() - started, error: describeFailure(error), ok: false };
    }
};

const TIMEOUT_MESSAGE = /timeout/iu;

/** A transport failure in words. The message itself is not shown: it can carry the URL and its query. */
const describeFailure = (error: unknown): string => {
    if (error instanceof Error && TIMEOUT_MESSAGE.test(error.message)) {
        return `The receiver did not answer within ${RUN_WEBHOOK_TIMEOUT_MS / 1000} seconds.`;
    }

    return `The request failed (${error instanceof Error ? error.name : "unknown error"}).`;
};
