/**
 * streaming.integration.test.ts
 *
 * Integration tests for POST /v1/chat/completions with stream=true.
 * Verifies SSE format, chunk structure, [DONE] termination, and that
 * each data chunk contains valid OpenAI-compatible chunk objects.
 */
import { describe, expect, it, vi } from "vitest";

import { createMockEnv, makeVirtualKeyRow } from "../helpers/mock-env.js";
import { useTrackedAppFetch } from "../helpers/tracked-app-fetch.js";

// Mock streamText before app is imported.
vi.mock("ai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    const mockFullStream = {
        [Symbol.asyncIterator]() {
            const parts: (
                { finishReason: string; type: "finish"; usage: { completionTokens: number; promptTokens: number } } | { text: string; type: "text-delta" }
            )[] = [
                { text: "Hello ", type: "text-delta" },
                { text: "world!", type: "text-delta" },
                {
                    finishReason: "stop",
                    type: "finish",
                    usage: { completionTokens: 5, promptTokens: 10 },
                },
            ];
            let i = 0;

            return {
                async next() {
                    if (i < parts.length) {
                        return { done: false, value: parts[i++]! };
                    }

                    return { done: true, value: undefined };
                },
            };
        },
    };

    return {
        ...actual,
        streamText: vi.fn().mockReturnValue({
            finishReason: Promise.resolve("stop"),
            fullStream: mockFullStream,
            usage: Promise.resolve({ completionTokens: 5, promptTokens: 10 }),
        }),
    };
});

// Spread the real module rather than listing its exports: a hand-written
// export list goes stale the moment production adds one, and the failure
// surfaces as a 502 from an unrelated endpoint rather than as a missing mock.
vi.mock("../../providers/factory.js", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../providers/factory.js")>()),
        createKeyPool: vi.fn(),
        createProviderModel: vi.fn().mockResolvedValue({ modelId: "mock", provider: "mock" }),
        resolveApiKey: vi.fn().mockReturnValue("test-api-key"),
        resolveApiKeys: vi.fn().mockReturnValue(["test-api-key"]),
    };
});

const TEST_TOKEN = "gk_streaming_test_abc123";
const env = createMockEnv({ apiKeyCacheRows: [await makeVirtualKeyRow(TEST_TOKEN, { tier: "pro" })] });

// A streamed reply's usage logging settles only once its body is drained; see
// `useTrackedAppFetch` for why every request is tracked and settled.
const fetchApp = useTrackedAppFetch();

/** Parse SSE response body into individual data lines. */
async function collectSSEChunks(res: Response): Promise<string[]> {
    const text = await res.text();

    return text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length));
}

describe("POST /v1/chat/completions (stream=true)", () => {
    it("returns Content-Type: text/event-stream", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "gpt-4o-mini",
                stream: true,
            }),
            headers: {
                Authorization: `Bearer ${TEST_TOKEN}`,
                "Content-Type": "application/json",
            },
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    });

    it("emits text-delta chunks followed by [DONE]", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "gpt-4o-mini",
                stream: true,
            }),
            headers: {
                Authorization: `Bearer ${TEST_TOKEN}`,
                "Content-Type": "application/json",
            },
            method: "POST",
        });
        const res = await fetchApp(request, env);
        const chunks = await collectSSEChunks(res);

        // Last chunk must be [DONE]
        expect(chunks.at(-1)).toBe("[DONE]");

        // At least one data chunk before [DONE]
        const dataChunks = chunks.slice(0, -1);

        expect(dataChunks.length).toBeGreaterThan(0);
    });

    it("each data chunk (before [DONE]) is valid JSON with chat.completion.chunk shape", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "gpt-4o-mini",
                stream: true,
            }),
            headers: {
                Authorization: `Bearer ${TEST_TOKEN}`,
                "Content-Type": "application/json",
            },
            method: "POST",
        });
        const res = await fetchApp(request, env);
        const chunks = await collectSSEChunks(res);
        const dataChunks = chunks.filter((c) => c !== "[DONE]");

        for (const raw of dataChunks) {
            const chunk = JSON.parse(raw) as { choices: unknown; created: unknown; id: unknown; model: unknown; object: unknown };

            expect(chunk.object).toBe("chat.completion.chunk");
            expect(typeof chunk.id).toBe("string");
            expect(typeof chunk.created).toBe("number");
            expect(chunk.model).toBe("gpt-4o-mini");

            const choices = chunk.choices as { delta: { content?: string }; finish_reason: unknown; index: number }[];

            expect(Array.isArray(choices)).toBe(true);
            expect(choices[0]?.index).toBe(0);
        }
    });

    it("assembles text-delta chunks into complete response text", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "gpt-4o-mini",
                stream: true,
            }),
            headers: {
                Authorization: `Bearer ${TEST_TOKEN}`,
                "Content-Type": "application/json",
            },
            method: "POST",
        });
        const res = await fetchApp(request, env);
        const chunks = await collectSSEChunks(res);
        const dataChunks = chunks.filter((c) => c !== "[DONE]");

        // Collect all text from delta.content fields
        const assembled = dataChunks
            .map((raw) => {
                const chunk = JSON.parse(raw) as {
                    choices: { delta: { content?: string } }[];
                };

                return chunk.choices[0]?.delta?.content ?? "";
            })
            .join("");

        expect(assembled).toContain("Hello ");
        expect(assembled).toContain("world!");
    });

    it("includes Cache-Control: no-store in streaming response (set by securityMiddleware)", async () => {
        // The streaming handler sets Cache-Control: no-cache, but securityMiddleware
        // runs after the route and overrides it to no-store for all responses.
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "gpt-4o-mini",
                stream: true,
            }),
            headers: {
                Authorization: `Bearer ${TEST_TOKEN}`,
                "Content-Type": "application/json",
            },
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect(res.headers.get("Cache-Control")).toBe("no-store");
    });
});
