import { describe, expect, it, vi } from "vitest";

import { GatewayError } from "../lib/errors.js";
import type { CustomProviderConfig } from "../providers/factory.js";
import { createProviderModel } from "../providers/factory.js";

const config = (baseUrl: string, format: CustomProviderConfig["format"] = "openai-chat"): CustomProviderConfig => {
    return { apiKey: "", baseUrl, format, id: "ollama" };
};

describe("createProviderModel — custom provider", () => {
    it("builds a Chat Completions model, not the Responses API", async () => {
        expect.assertions(2);

        const model = (await createProviderModel("custom", "llama3.1:8b", "", undefined, undefined, config("https://ollama.example.com/v1/"))) as {
            modelId: string;
            provider: string;
        };

        expect(model.modelId).toBe("llama3.1:8b");
        expect(model.provider).toBe("openai.chat");
    });

    it("builds an Anthropic Messages model for the anthropic format", async () => {
        expect.assertions(2);

        const model = (await createProviderModel(
            "custom",
            "claude-sonnet-4",
            "",
            undefined,
            undefined,
            config("https://api.deepseek.com/anthropic", "anthropic"),
        )) as { modelId: string; provider: string };

        expect(model.modelId).toBe("claude-sonnet-4");
        expect(model.provider).toBe("anthropic.messages");
    });

    it("sends Anthropic requests to {root}/v1/messages without following redirects", async () => {
        expect.assertions(4);

        const calls: { init?: RequestInit; url: string }[] = [];

        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ init, url: String(input) });

            return Response.json({ error: { message: "stop", type: "invalid_request_error" }, type: "error" }, { status: 400 });
        });

        try {
            const model = (await createProviderModel("custom", "m", "", undefined, undefined, {
                ...config("https://proxy.example.com/", "anthropic"),
                apiKey: "sk-ant",
            })) as unknown as { doGenerate: (options: unknown) => Promise<unknown> };

            await model.doGenerate({ prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }] }).catch(() => undefined);
        } finally {
            vi.unstubAllGlobals();
        }

        expect(calls[0]?.url).toBe("https://proxy.example.com/v1/messages");
        expect(calls[0]?.init?.redirect).toBe("manual");

        const headers = new Headers(calls[0]?.init?.headers);

        expect(headers.get("x-api-key")).toBe("sk-ant");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
    });

    it("refuses a private Anthropic base URL too", async () => {
        expect.assertions(1);

        await expect(createProviderModel("custom", "m", "", undefined, undefined, config("https://10.0.0.5", "anthropic"))).rejects.toBeInstanceOf(
            GatewayError,
        );
    });

    it.each([
        ["loopback", "https://127.0.0.1:11434/v1"],
        ["localhost", "https://localhost:11434/v1"],
        ["private range", "https://192.168.1.10/v1"],
        ["cloud metadata via mapped IPv6", "https://[::ffff:169.254.169.254]/v1"],
        // Built at runtime: a lint autofix rewrites literal insecure URLs to https.
        ["plain http", ["http", "//ollama.example.com/v1"].join(":")],
    ])("refuses a %s base URL", async (_label, baseUrl) => {
        expect.assertions(1);

        await expect(createProviderModel("custom", "m", "", undefined, undefined, config(baseUrl))).rejects.toBeInstanceOf(GatewayError);
    });

    it("rejects a missing config", async () => {
        expect.assertions(1);

        await expect(createProviderModel("custom", "m", "")).rejects.toThrow("requires a customProvider config");
    });
});
