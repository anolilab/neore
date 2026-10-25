/**
 * The real provider adapter against a mocked upstream (msw). The gateway's
 * model-proxy tests mock the model; these run the AI SDK's Chat Completions
 * adapter on actual SSE bytes, so the parsing, the usage extraction and a
 * provider error inside the stream are exercised for real.
 */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { CustomProviderConfig } from "../providers/factory.js";
import { createProviderModel } from "../providers/factory.js";

const UPSTREAM = "https://upstream.test/v1";
const COMPLETIONS = `${UPSTREAM}/chat/completions`;

const sse = (events: unknown[]) => {
    const body = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");

    return new HttpResponse(body, { headers: { "content-type": "text/event-stream" } });
};

const config = (): CustomProviderConfig => {
    return { apiKey: "sk-test", baseUrl: UPSTREAM, format: "openai-chat", id: "upstream" };
};

const prompt = [{ content: [{ text: "hi", type: "text" as const }], role: "user" as const }];

/** Reads every part of a provider stream. */
const drain = async (stream: ReadableStream<{ type: string }>) => {
    const parts: { type: string }[] = [];
    const reader = stream.getReader();

    for (;;) {
        const { done, value } = await reader.read();

        if (done) {
            return parts;
        }

        parts.push(value);
    }
};

const server = setupServer();

beforeAll(() => {
    server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
    server.resetHandlers();
});

afterAll(() => {
    server.close();
});

describe("provider stream — real Chat Completions adapter over msw", () => {
    it("streams text deltas and reports the usage from the final chunk", async () => {
        server.use(
            http.post(COMPLETIONS, () =>
                sse([
                    { choices: [{ delta: { content: "Hel" }, index: 0 }], id: "c1", model: "m", object: "chat.completion.chunk" },
                    { choices: [{ delta: { content: "lo" }, index: 0 }], id: "c1", model: "m", object: "chat.completion.chunk" },
                    {
                        choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
                        id: "c1",
                        model: "m",
                        object: "chat.completion.chunk",
                        usage: { completion_tokens: 3, prompt_tokens: 10, total_tokens: 13 },
                    },
                    "[DONE]",
                ]),
            ),
        );

        const model = (await createProviderModel("custom", "m", "", undefined, undefined, config())) as unknown as {
            doStream: (options: unknown) => Promise<{ stream: ReadableStream<{ type: string }> }>;
        };
        const { stream } = await model.doStream({ prompt });
        const parts = await drain(stream);
        const text = parts
            .filter((part): part is { delta: string; type: "text-delta" } & { type: string } => part.type === "text-delta")
            .map((part) => (part as { delta: string }).delta)
            .join("");
        const finish = parts.find((part) => part.type === "finish") as
            { usage: { inputTokens: { total: number }; outputTokens: { total: number } } } | undefined;

        expect(text).toBe("Hello");
        expect(finish?.usage.inputTokens.total).toBe(10);
        expect(finish?.usage.outputTokens.total).toBe(3);
    });

    it("surfaces a provider error inside the stream as an error part", async () => {
        server.use(
            http.post(COMPLETIONS, () =>
                sse([
                    { choices: [{ delta: { content: "partial" }, index: 0 }], id: "c2", model: "m", object: "chat.completion.chunk" },
                    { error: { message: "upstream overloaded", type: "server_error" } },
                ]),
            ),
        );

        const model = (await createProviderModel("custom", "m", "", undefined, undefined, config())) as unknown as {
            doStream: (options: unknown) => Promise<{ stream: ReadableStream<{ type: string }> }>;
        };
        const { stream } = await model.doStream({ prompt });
        const parts = await drain(stream);

        expect(parts.some((part) => part.type === "text-delta")).toBe(true);
        expect(parts.some((part) => part.type === "error")).toBe(true);
    });

    it("rejects the call when the upstream refuses it, before any part is streamed", async () => {
        server.use(
            http.post(COMPLETIONS, () =>
                HttpResponse.json({ error: { message: "rate limited", type: "rate_limit_error" } }, { headers: { "retry-after": "5" }, status: 429 }),
            ),
        );

        const model = (await createProviderModel("custom", "m", "", undefined, undefined, config())) as unknown as {
            doStream: (options: unknown) => Promise<unknown>;
        };

        await expect(model.doStream({ prompt })).rejects.toThrow();
    });
});
