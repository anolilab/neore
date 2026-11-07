/**
 * A message into a coding-agent thread from the browser (`POST /hosts/send`, backend `acp/send.ts`). The backend
 * stores the prompt, the turn's stream and the signed command in one write before it answers, so a request that
 * dies on the way is retried with the SAME request id and finds the first try, never a second turn. What the turn
 * is doing is read from the stream like any other viewer's (`StreamingPlaceholder`), not from this answer.
 */
import { withUnlockProofBody } from "@neore/client-runtime";

import getSessionToken from "@/lib/auth/server-functions";
import env from "@/lib/env";

/** The backend's refusals, by the `error` field of the answer. */
export type HostSendError =
    | "busy"
    | "locked"
    | "not_authenticated"
    | "not_found"
    | "offline"
    | "outdated"
    | "rate_limited"
    | "session_ended"
    | "session_starting"
    | "too_large"
    | "turn_running"
    | "unreachable"
    | "worker_thread";

/**
 * `streamId` is the turn the message started, or, for a repeat of an earlier request (`duplicate`), the turn that request
 * started, which may have ended long ago. Either may be missing from an answer that could not be read.
 */
export type HostSendResult = { duplicate?: boolean; ok: true; streamId?: string } | { error: HostSendError; ok: false };

const KNOWN: ReadonlySet<string> = new Set([
    "busy",
    "locked",
    "not_authenticated",
    "not_found",
    "offline",
    "outdated",
    "rate_limited",
    "session_ended",
    "session_starting",
    "too_large",
    "turn_running",
    "worker_thread",
]);

/** The longest prompt `/hosts/send` takes (`MAX_SEND_CHARS` in `backend/lunora/acp/send.ts`). */
export const MAX_HOST_PROMPT_CHARS = 30_000;

const errorOf = async (response: Response): Promise<HostSendError> => {
    try {
        const body = (await response.json()) as { error?: unknown };

        return typeof body.error === "string" && KNOWN.has(body.error) ? (body.error as HostSendError) : "unreachable";
    } catch {
        return "unreachable";
    }
};

const SEND_DEADLINE_MS = 30_000;

/** A 200's body. The message is sent whatever the body says; what it names is only a hint for the composer. */
const acceptedOf = async (response: Response): Promise<HostSendResult> => {
    try {
        const body = (await response.json()) as { duplicate?: unknown; streamId?: unknown };

        return {
            ok: true,
            ...(body.duplicate === true && { duplicate: true }),
            ...(typeof body.streamId === "string" && { streamId: body.streamId }),
        };
    } catch {
        return { ok: true };
    }
};

export const sendHostMessage = async (
    input: { requestId: string; text: string; threadId: string },
    options: { fetch?: typeof fetch; token?: () => Promise<string | null | undefined> } = {},
): Promise<HostSendResult> => {
    try {
        const token = await (options.token ?? getSessionToken)();
        const response = await (options.fetch ?? fetch)(new URL("/hosts/send", env.VITE_LUNORA_URL), {
            // A locked chat takes the message only with its live passcode proof, as /chat/start does.
            body: JSON.stringify(withUnlockProofBody(input, input.threadId)),
            headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
            method: "POST",
            // A stalled connection must not leave the composer in its sending state for good.
            signal: AbortSignal.timeout(SEND_DEADLINE_MS),
        });

        return response.ok ? await acceptedOf(response) : { error: await errorOf(response), ok: false };
    } catch {
        return { error: "unreachable", ok: false };
    }
};
