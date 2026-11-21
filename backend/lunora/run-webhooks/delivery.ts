/**
 * One signed POST of a run webhook event to the user's URL.
 *
 * The POST goes through `postCheckedHttps` (`lib/egress.ts`): the host name is
 * resolved, every answer must be a public address, and the connection goes to
 * that address with the certificate checked against the host name. Redirects are
 * not followed, so a 3xx is a failed delivery, reported as one.
 *
 * What the answer tells the user is limited on purpose: the status code and the
 * time taken. The helper reads only the status line, so a receiver cannot push
 * text into the app's responses.
 */
import { type EgressErrorCode, EgressError, type EgressRequest, type EgressResponse, postCheckedHttps } from "../lib/egress";
import { type RunWebhookEvent, runWebhookUrlProblem, signRunWebhook } from "./payload";
import { runWebhookConnect } from "./socket";

/** How long a receiver may take to answer. Part 2's retries reuse it per attempt. */
export const RUN_WEBHOOK_TIMEOUT_MS = 10_000;

export type RunWebhookSend = (request: EgressRequest) => Promise<EgressResponse>;

export interface RunWebhookAttempt {
    durationMs: number;
    error?: string;
    ok: boolean;
    status?: number;
}

const defaultSend: RunWebhookSend = async (request) =>
    await postCheckedHttps(request, {
        connect: runWebhookConnect,
        fetch: async (input, init) => await fetch(input, init),
    });

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
        const response = await send({
            body,
            headers: {
                "content-type": "application/json",
                "user-agent": "Neore-Webhooks",
                "x-neore-event": event.type,
                "x-neore-event-id": event.id,
                ...signature,
            },
            timeoutMs: RUN_WEBHOOK_TIMEOUT_MS,
            url,
        });

        return {
            durationMs: Date.now() - started,
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
        };
    } catch (error) {
        return { durationMs: Date.now() - started, error: describeFailure(error), ok: false };
    }
};

/**
 * Each refusal in words. None of them carries the URL, the host name or the
 * secret: the messages are fixed, and a transport error's own text is never used.
 */
const FAILURE_WORDS: Record<EgressErrorCode, string> = {
    bad_header: "The request could not be built.",
    bad_response: "The receiver's answer could not be read.",
    bad_url: "The URL must use https:// on port 443 and carry no login details.",
    blocked_address: "The host resolves to a private, local or reserved address, so it was refused.",
    dns_failed: "The host name could not be looked up.",
    timeout: `The receiver did not answer within ${RUN_WEBHOOK_TIMEOUT_MS / 1000} seconds.`,
    unsupported_target: "This host is served by Cloudflare, which Neore cannot connect to yet.",
};

/** A transport failure in words. The message itself is not shown: it can carry the URL and its query. */
const describeFailure = (error: unknown): string => {
    if (error instanceof EgressError) {
        return FAILURE_WORDS[error.code];
    }

    return `The request failed (${error instanceof Error ? error.name : "unknown error"}).`;
};
