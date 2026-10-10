/**
 * completions.integration.test.ts
 *
 * Integration tests for POST /v1/chat/completions (non-streaming).
 * Verifies request parsing, response shape, model resolution, and
 * error handling — all without real LLM provider calls.
 */
import { describe, expect, it, vi } from "vitest";

import { createMockEnv, makeVirtualKeyRow } from "../helpers/mock-env.js";
import { useTrackedAppFetch } from "../helpers/tracked-app-fetch.js";

// Mock the AI SDK's generateText so no real LLM calls are made.
// This must be before any imports that pull in the app.
vi.mock("ai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        generateText: vi.fn().mockResolvedValue({
            finishReason: "stop",
            text: "Hello from mock LLM",
            toolCalls: [],
            // AI SDK v6 uses inputTokens/outputTokens (not promptTokens/completionTokens).
            usage: { inputTokens: 10, outputTokens: 20 },
        }),
    };
});

// Mock the provider factory to avoid dynamic SDK imports.
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

const TEST_TOKEN = "gk_completions_test_abc123";
const env = createMockEnv({ apiKeyCacheRows: [await makeVirtualKeyRow(TEST_TOKEN, { tier: "pro" })] });

const authHeaders = () => {
    return {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
    };
};

const fetchApp = useTrackedAppFetch();

describe("POST /v1/chat/completions (non-streaming)", () => {
    it("returns 200 with OpenAI-compatible response shape", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "Say hello", role: "user" }],
                model: "gpt-4o-mini",
            }),
            headers: authHeaders(),
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect(res.status).toBe(200);

        const body = (await res.json()) as {
            choices: unknown;
            created: unknown;
            id: unknown;
            model: unknown;
            object: unknown;
            usage: unknown;
        };

        expect(body.object).toBe("chat.completion");
        expect(typeof body.id).toBe("string");
        expect((body.id as string).startsWith("chatcmpl-")).toBe(true);
        expect(typeof body.created).toBe("number");
        expect(body.model).toBe("gpt-4o-mini");

        const choices = body.choices as { finish_reason: string; index: number; message: { content: string; role: string } }[];

        expect(choices).toHaveLength(1);
        expect(choices[0]?.message.role).toBe("assistant");
        expect(choices[0]?.message.content).toBe("Hello from mock LLM");
        expect(choices[0]?.finish_reason).toBe("stop");

        const usage = body.usage as { completion_tokens: number; prompt_tokens: number; total_tokens: number };

        expect(usage.prompt_tokens).toBe(10);
        expect(usage.completion_tokens).toBe(20);
        expect(usage.total_tokens).toBe(30);
    });

    it("returns 400 when body fails schema validation (missing messages)", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({ model: "gpt-4o-mini" }),
            headers: authHeaders(),
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { type: string } };

        expect(body.error.type).toBe("invalid_request_error");
    });

    it("returns 400 for unknown model", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "nonexistent-model-xyz",
            }),
            headers: authHeaders(),
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect(res.status).toBe(400);
    });

    it("passes system messages through to the model", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [
                    { content: "You are helpful.", role: "system" },
                    { content: "Hello!", role: "user" },
                ],
                model: "gpt-4o-mini",
            }),
            headers: authHeaders(),
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect(res.status).toBe(200);
    });

    it("includes X-Request-Id header in response", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "gpt-4o-mini",
            }),
            headers: authHeaders(),
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect(res.status).toBe(200);
        expect(res.headers.get("X-Request-Id")).not.toBeNull();
    });

    it("returns 401 for missing Authorization header", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "gpt-4o-mini",
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect(res.status).toBe(401);
    });

    it("returns 401 for token with wrong prefix (not gk_)", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "gpt-4o-mini",
            }),
            headers: {
                Authorization: "Bearer sk_wrong_prefix_token", // secret-scanner:allow — fixture credential for a 401 test, not a real key
                "Content-Type": "application/json",
            },
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect(res.status).toBe(401);
    });
});
