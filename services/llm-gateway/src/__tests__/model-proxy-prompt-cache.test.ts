/**
 * Backend chat calls reach the provider only through `/internal/model/proxy`, so the
 * conversation breakpoint must be on the prompt that route hands to the provider model.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProviderModelForEnv } from "../providers/factory.js";
import { bindingEnv } from "./helpers/internal.js";
import { createMockEnv } from "./helpers/mock-env.js";
import { useTrackedAppFetch } from "./helpers/tracked-app-fetch.js";

vi.mock("../providers/factory.js", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../providers/factory.js")>()),
        createProviderModelForEnv: vi.fn(),
        resolveApiKey: vi.fn().mockReturnValue("test-api-key"),
    };
});

const fetchApp = useTrackedAppFetch();

interface SentPrompt {
    prompt: {
        content: unknown;
        providerOptions?: { anthropic?: { cacheControl?: { type: string } } };
        role: string;
    }[];
}

const chatPrompt = [
    { content: "You are helpful.", role: "system" },
    { content: [{ text: "first question", type: "text" }], role: "user" },
    { content: [{ text: "first answer", type: "text" }], role: "assistant" },
    { content: [{ text: "follow up", type: "text" }], role: "user" },
];

/** Runs one generate call through the route and returns the options the provider model received. */
const sendThrough = async (provider: string, modelApiId: string): Promise<SentPrompt> => {
    const received: unknown[] = [];
    const capture = async (options: unknown) => {
        received.push(options);
        throw new Error("stop here: only the prompt matters");
    };

    vi.mocked(createProviderModelForEnv).mockResolvedValueOnce({ doGenerate: capture, doStream: capture } as never);

    await fetchApp(
        new Request("http://localhost/internal/model/proxy", {
            body: JSON.stringify({
                action: "generate",
                callOptions: { prompt: chatPrompt },
                modelApiId,
                modelId: modelApiId,
                provider,
                requestId: "req-prompt-cache-1",
                userId: "user-1",
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        }),
        bindingEnv(createMockEnv()),
    );

    return received[0] as SentPrompt;
};

describe("POST /internal/model/proxy prompt caching", () => {
    afterEach(() => {
        vi.mocked(createProviderModelForEnv).mockReset();
    });

    it("places the conversation breakpoint on the last message for an OpenRouter chat call", async () => {
        const sent = await sendThrough("openrouter", "anthropic/claude-sonnet-4");
        const breakpoints = sent.prompt.flatMap((message, index) => (message.providerOptions?.anthropic ? [index] : []));

        expect(breakpoints).toEqual([0, chatPrompt.length - 1]);
        expect(sent.prompt.at(-1)?.providerOptions?.anthropic).toEqual({ cacheControl: { type: "ephemeral" } });
    });

    it("leaves the prompt the backend sent unchanged for a provider outside the scope", async () => {
        const sent = await sendThrough("google", "gemini-2.5-flash");

        expect(sent.prompt.every((message) => message.providerOptions === undefined)).toBe(true);
        expect(sent.prompt).toHaveLength(chatPrompt.length);
    });
});
