import type { Fetch } from "../auth/grant";

export interface StartedChat {
    contentType: string;
    /** A resend of a send the server already took (same `clientMessageId`): these are that send's ids, and nothing was saved again. */
    duplicate?: boolean;
    messageId: string;
    streamId: string;
    streaming: boolean;
    streamToken: string;
    threadId: string;
}

export interface StartChatBody {
    /** One per composed message, the same on every retry of it: the server saves the message once (`/chat/start`). */
    clientMessageId?: string;
    model: string;
    prompt: string;
    threadId?: string;
}

/** The first send of this `clientMessageId` is still being saved (409): wait and send it again, it is no failure. */
export const START_IN_PROGRESS_CODE = "chat_start_in_progress";

/** The `clientMessageId` was used for a different request (422): a client bug, never retried. */
export const CLIENT_MESSAGE_ID_REUSED_CODE = "client_message_id_reused";

export class ChatError extends Error {
    /** The server's code for the error, lower-cased (`/chat/start` sends `CHAT_START_IN_PROGRESS`, the public API `chat_start_in_progress`). */
    public readonly code: string | undefined;

    /**
     * The gateway answered and refused the start (a 4xx status): the prompt was not taken. A 5xx may come after it was,
     * and a 409 `chat_start_in_progress` says it is being taken.
     */
    public readonly isRefusal: boolean;

    public constructor(message: string, options: { code?: string; isRefusal?: boolean } = {}) {
        super(message);
        this.name = "ChatError";
        this.code = options.code;
        this.isRefusal = options.isRefusal ?? false;
    }
}

/** The send's first try is still being saved: the same send, sent again shortly, gets its ids. */
export const isStartInProgress = (error: unknown): boolean => error instanceof ChatError && error.code === START_IN_PROGRESS_CODE;

/** The `clientMessageId` belongs to a different request. */
export const isClientMessageIdReused = (error: unknown): boolean => error instanceof ChatError && error.code === CLIENT_MESSAGE_ID_REUSED_CODE;

/** A server error code: a SCREAMING_CASE or snake_case token, not a sentence. */
const ERROR_CODE_PATTERN = /^[A-Za-z_]+$/u;

const isErrorCode = (value: unknown): value is string => typeof value === "string" && ERROR_CODE_PATTERN.test(value);

/**
 * The gateway sends `{ error: "CODE", message }` (from `/chat/start`), a plain string, or `{ error: { code, message } }`
 * (a rate limit, for one). The message prefers the readable text; the code is lower-cased.
 */
const errorDetails = (body: { error?: unknown; message?: unknown }): { code?: string; message?: string } => {
    const { error } = body;

    if (typeof error === "string") {
        return {
            ...isErrorCode(error) && { code: error.toLowerCase() },
            message: typeof body.message === "string" ? body.message : error,
        };
    }

    if (typeof error === "object" && error !== null) {
        const { code, message } = error as { code?: unknown; message?: unknown };

        return { ...isErrorCode(code) && { code: code.toLowerCase() }, ...typeof message === "string" && { message } };
    }

    return {};
};

/** Same bound as the web app's default third-party deadline (backend fetch-timeout). The reply stream is not bounded. */
export const CHAT_START_TIMEOUT_MS = 15_000;

/** POST /v1/chat on the gateway. The gateway forwards the bearer to the backend's /chat/start. */
export const startChat = async (input: { body: StartChatBody; fetch: Fetch; gatewayUrl: string; jwt: string }): Promise<StartedChat> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_START_TIMEOUT_MS);

    try {
        const response = await input.fetch(`${input.gatewayUrl}/v1/chat`, {
            body: JSON.stringify(input.body),
            headers: { Authorization: `Bearer ${input.jwt}`, "Content-Type": "application/json" },
            method: "POST",
            signal: controller.signal,
        });

        if (!response.ok) {
            let body: { error?: unknown; message?: unknown } = {};

            try {
                const parsed: unknown = await response.json();

                // JSON `null` or a bare value parses too: only an object can carry `error`.
                if (typeof parsed === "object" && parsed !== null) {
                    body = parsed as { error?: unknown; message?: unknown };
                }
            } catch {
                // A body that is not JSON keeps the status-based message.
            }

            const { code, message } = errorDetails(body);

            // A 5xx can come after the backend saved the prompt (a failed stream setup, a lost relay), and a 409
            // `chat_start_in_progress` is the first try still saving it: neither is a refusal.
            throw new ChatError(message ?? `Could not send (${response.status}).`, {
                ...code !== undefined && { code },
                isRefusal: response.status < 500 && code !== START_IN_PROGRESS_CODE,
            });
        }

        return (await response.json()) as StartedChat;
    } catch (error) {
        if (controller.signal.aborted) {
            // The request may have reached the gateway before the deadline: not a refusal.
            throw new ChatError("The gateway did not answer in time.");
        }

        throw error;
    } finally {
        clearTimeout(timer);
    }
};
