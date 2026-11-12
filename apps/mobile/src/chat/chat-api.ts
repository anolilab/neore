import type { Fetch } from "../auth/grant";

export interface StartedChat {
    contentType: string;
    messageId: string;
    streamId: string;
    streaming: boolean;
    streamToken: string;
    threadId: string;
}

export interface StartChatBody {
    model: string;
    prompt: string;
    threadId?: string;
}

export class ChatError extends Error {
    /** The gateway answered and refused the start (a 4xx status): the prompt was not taken. A 5xx may come after it was. */
    public readonly isRefusal: boolean;

    public constructor(message: string, options: { isRefusal?: boolean } = {}) {
        super(message);
        this.name = "ChatError";
        this.isRefusal = options.isRefusal ?? false;
    }
}

/** The gateway sends either a string or `{ code, message }` (a rate limit, for one); anything else keeps the status message. */
const errorMessage = (body: { error?: unknown }): string | undefined => {
    const { error } = body;

    if (typeof error === "string") {
        return error;
    }

    if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
        return (error as { message: string }).message;
    }

    return undefined;
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
            let body: { error?: unknown } = {};

            try {
                const parsed: unknown = await response.json();

                // JSON `null` or a bare value parses too: only an object can carry `error`.
                if (typeof parsed === "object" && parsed !== null) {
                    body = parsed as { error?: unknown };
                }
            } catch {
                // A body that is not JSON keeps the status-based message.
            }

            // A 5xx can come after the backend saved the prompt (a failed stream setup, a lost relay): not a refusal.
            throw new ChatError(errorMessage(body) ?? `Could not send (${response.status}).`, { isRefusal: response.status < 500 });
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
