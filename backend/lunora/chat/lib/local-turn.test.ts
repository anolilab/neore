import { describe, expect, it } from "vitest";

import type { StoredCustomProvider } from "./custom-providers";
import { buildLocalTurnMessages, deriveLocalThreadTitle, LOCAL_BROWSER_PROVIDER, MAX_LOCAL_REPLY_CHARS, resolveLocalModel } from "./local-turn";

const endpoint = (overrides: Partial<StoredCustomProvider> = {}): StoredCustomProvider => {
    return {
        enabled: true,
        encryptedKey: "",
        endpoint: ["http", "//localhost:11434/v1"].join(":"),
        models: [{ id: "llama3.2:3b" }],
        name: "Ollama",
        type: "local-browser",
        ...overrides,
    };
};

describe(resolveLocalModel, () => {
    it("resolves a listed model on an enabled local endpoint", () => {
        expect.assertions(1);
        expect(resolveLocalModel("custom:ollama/llama3.2:3b", { ollama: endpoint() })).toStrictEqual({ modelId: "llama3.2:3b", providerId: "ollama" });
    });

    it.each([
        ["a platform model", "gpt-4o", { ollama: endpoint() }],
        ["an unknown endpoint", "custom:other/llama3.2:3b", { ollama: endpoint() }],
        ["a disabled endpoint", "custom:ollama/llama3.2:3b", { ollama: endpoint({ enabled: false }) }],
        ["a server-side endpoint", "custom:ollama/llama3.2:3b", { ollama: endpoint({ type: "openai" }) }],
        ["an endpoint with no type (legacy openai)", "custom:ollama/llama3.2:3b", { ollama: endpoint({ type: undefined }) }],
        ["an unlisted model", "custom:ollama/qwen3:8b", { ollama: endpoint() }],
    ])("refuses %s", (_label, model, providers) => {
        expect.assertions(1);
        expect(resolveLocalModel(model, providers)).toHaveProperty("error");
    });
});

describe(deriveLocalThreadTitle, () => {
    it("collapses whitespace and truncates long prompts", () => {
        expect.assertions(3);
        expect(deriveLocalThreadTitle("  hello\n\n  world ")).toBe("hello world");
        expect(deriveLocalThreadTitle("x".repeat(100))).toHaveLength(60);
        expect(deriveLocalThreadTitle(" ".repeat(3))).toBe("Local chat");
    });
});

describe(buildLocalTurnMessages, () => {
    it("saves the prompt and a text-only reply marked local and unbilled", () => {
        expect.assertions(4);

        const [user, assistant] = buildLocalTurnMessages({ modelId: "llama3.2:3b", outcome: "complete", prompt: "hi", reply: "hello" });

        expect(user).toStrictEqual({ message: { content: "hi", role: "user" }, status: "success" });
        expect(assistant?.message).toStrictEqual({ content: [{ text: "hello", type: "text" }], role: "assistant" });
        expect(assistant).toMatchObject({ finishReason: "stop", model: "llama3.2:3b", provider: LOCAL_BROWSER_PROVIDER, status: "success" });
        expect(assistant).not.toHaveProperty("usage");
    });

    it("keeps partial text and the error on a failed stream", () => {
        expect.assertions(1);

        const [, assistant] = buildLocalTurnMessages({ error: "connection reset", modelId: "m", outcome: "failed", prompt: "p", reply: "partial" });

        expect(assistant).toMatchObject({ error: "connection reset", finishReason: "error", status: "failed" });
    });

    it("stores an aborted reply as a normal one that ended early", () => {
        expect.assertions(1);

        const [, assistant] = buildLocalTurnMessages({ modelId: "m", outcome: "aborted", prompt: "p", reply: "half" });

        expect(assistant).toMatchObject({ finishReason: "other", status: "success" });
    });

    it("drops blank reasoning and caps the reply", () => {
        expect.assertions(2);

        const [, assistant] = buildLocalTurnMessages({
            modelId: "m",
            outcome: "complete",
            prompt: "p",
            reasoning: "  ",
            reply: "y".repeat(MAX_LOCAL_REPLY_CHARS + 5),
        });

        expect(assistant).not.toHaveProperty("reasoning");
        expect((assistant?.message.content[0] as { text: string }).text).toHaveLength(MAX_LOCAL_REPLY_CHARS);
    });
});
