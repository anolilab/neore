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
    public constructor(message: string) {
        super(message);
        this.name = "ChatError";
    }
}

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
            let body: { error?: string } = {};

            try {
                body = (await response.json()) as { error?: string };
            } catch {
                // A body that is not JSON keeps the status-based message.
            }

            throw new ChatError(body.error ?? `Could not send (${response.status}).`);
        }

        return (await response.json()) as StartedChat;
    } catch (error) {
        if (controller.signal.aborted) {
            throw new ChatError("The gateway did not answer in time. Try again.");
        }

        throw error;
    } finally {
        clearTimeout(timer);
    }
};
