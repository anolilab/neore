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

/** POST /v1/chat on the gateway. The gateway forwards the bearer to the backend's /chat/start. */
export const startChat = async (input: { body: StartChatBody; fetch: Fetch; gatewayUrl: string; jwt: string }): Promise<StartedChat> => {
    const response = await input.fetch(`${input.gatewayUrl}/v1/chat`, {
        body: JSON.stringify(input.body),
        headers: { Authorization: `Bearer ${input.jwt}`, "Content-Type": "application/json" },
        method: "POST",
    });

    if (!response.ok) {
        const body = (await response.json().catch(() => { return {}; })) as { error?: string };

        throw new ChatError(body.error ?? `Could not send (${response.status}).`);
    }

    return (await response.json()) as StartedChat;
};
