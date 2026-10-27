/**
 * A provider failure on `/internal/model/proxy` carries the gateway's own
 * classification (`error.fallbackReason`), so the backend retries a reply on the
 * user's backup model only for an infrastructure failure.
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

/** A provider rejection shaped like the AI SDK's `APICallError`. */
const providerError = (statusCode: number | undefined, responseBody: string) =>
    Object.assign(new Error(responseBody), { responseBody, ...(statusCode !== undefined && { statusCode }) });

const proxy = async (action: "generate" | "stream", error: Error, promptText = "hi") => {
    const failing = async () => {
        throw error;
    };

    vi.mocked(createProviderModelForEnv).mockResolvedValueOnce({ doGenerate: failing, doStream: failing } as never);

    const response = await fetchApp(
        new Request("http://localhost/internal/model/proxy", {
            body: JSON.stringify({
                action,
                callOptions: { prompt: [{ content: [{ text: promptText, type: "text" }], role: "user" }] },
                modelApiId: "gemini-2.5-flash",
                modelId: "gemini-2.5-flash",
                provider: "google",
                requestId: "req-fallback-1",
                userId: "user-1",
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        }),
        bindingEnv(createMockEnv()),
    );

    return { body: (await response.json()) as { error: { code: string; fallbackReason?: string } }, status: response.status };
};

describe("POST /internal/model/proxy tags a provider failure with its fallback reason", () => {
    afterEach(() => {
        vi.mocked(createProviderModelForEnv).mockReset();
    });

    it.each(["generate", "stream"] as const)("%s: a 5xx is infra", async (action) => {
        const { body, status } = await proxy(action, providerError(503, "service unavailable"));

        expect(status).toBe(502);
        expect(body.error.fallbackReason).toBe("infra");
    });

    it("a 429 is infra", async () => {
        const { body } = await proxy("generate", providerError(429, "rate limited"));

        expect(body.error.fallbackReason).toBe("infra");
    });

    it("a rate limit that carries its status as `status` is infra", async () => {
        const error = Object.assign(new Error("slow down"), { status: 429 });
        const { body } = await proxy("generate", error);

        expect(body.error.fallbackReason).toBe("infra");
    });

    describe("an error part sent in-band by the provider", () => {
        const streamOf = async (parts: unknown[]) => {
            vi.mocked(createProviderModelForEnv).mockResolvedValueOnce({
                doStream: async () => {
                    return {
                        stream: new ReadableStream({
                            start(controller) {
                                for (const part of parts) controller.enqueue(part);

                                controller.close();
                            },
                        }),
                    };
                },
            } as never);

            const response = await fetchApp(
                new Request("http://localhost/internal/model/proxy", {
                    body: JSON.stringify({
                        action: "stream",
                        callOptions: { prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }] },
                        modelApiId: "gemini-2.5-flash",
                        modelId: "gemini-2.5-flash",
                        provider: "google",
                        requestId: "req-inband-1",
                        userId: "user-1",
                    }),
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                }),
                bindingEnv(createMockEnv()),
            );

            const text = await response.text();

            return text
                .split("\n\n")
                .filter((line) => line.startsWith("data: "))
                .map((line) => JSON.parse(line.slice(6)) as { fallbackReason?: string; type: string });
        };

        it("before any content is classified like a thrown error", async () => {
            const events = await streamOf([
                { type: "stream-start", warnings: [] },
                { error: providerError(529, "overloaded"), type: "error" },
            ]);

            expect(events.find((event) => event.type === "error")?.fallbackReason).toBe("infra");
        });

        it("after content has gone out is left unclassified", async () => {
            const events = await streamOf([
                { delta: "hi", id: "1", type: "text-delta" },
                { error: providerError(503, "unavailable"), type: "error" },
            ]);

            expect(events.find((event) => event.type === "error")?.fallbackReason).toBeUndefined();
        });

        it("before any content is not retryable when the provider rejected the request", async () => {
            const events = await streamOf([{ error: providerError(401, "bad key"), type: "error" }]);

            expect(events.find((event) => event.type === "error")?.fallbackReason).toBeUndefined();
        });
    });

    it("a 401 that carries its status as `status` is not retryable", async () => {
        const { body } = await proxy("generate", Object.assign(new Error("bad key"), { status: 401 }));

        expect(body.error.fallbackReason).toBeUndefined();
    });

    it("an error with no status (a timeout, a dropped connection) is infra", async () => {
        const { body } = await proxy("generate", providerError(undefined, "fetch failed"));

        expect(body.error.fallbackReason).toBe("infra");
    });

    it("a 400 refusal is content_policy", async () => {
        const { body } = await proxy("generate", providerError(400, '{"error":{"message":"Request blocked by content policy"}}'));

        expect(body.error.fallbackReason).toBe("content_policy");
    });

    it("a 413 is context_overflow", async () => {
        const { body } = await proxy("generate", providerError(413, "payload too large"));

        expect(body.error.fallbackReason).toBe("context_overflow");
    });

    it("a 400 on a prompt past the model's context window is context_overflow", async () => {
        // gemini-2.5-flash has a 1M-token window; 4M characters estimate to 1M tokens.
        const { body } = await proxy("generate", providerError(400, "invalid argument: input is too long"), "x".repeat(4_000_000));

        expect(body.error.fallbackReason).toBe("context_overflow");
    });

    it.each([
        ['{"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 128000 tokens."}}'],
        ['{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}'],
    ])("a 400 that says the context limit was exceeded is context_overflow on a short prompt: %s", async (responseBody) => {
        const { body } = await proxy("generate", providerError(400, responseBody));

        expect(body.error.fallbackReason).toBe("context_overflow");
    });

    it("a 400 on a prompt inside the window is not retryable", async () => {
        const { body } = await proxy("generate", providerError(400, "invalid argument: bad schema"));

        expect(body.error.fallbackReason).toBeUndefined();
    });

    it.each([401, 402, 403, 404, 422])("a %s is not retryable on another model", async (statusCode) => {
        const { body } = await proxy("generate", providerError(statusCode, "rejected"));

        expect(body.error.fallbackReason).toBeUndefined();
    });

    it("an internal error with no provider status is not retryable", async () => {
        const { body } = await proxy("generate", providerError(undefined, "Cannot read properties of undefined"));

        expect(body.error.fallbackReason).toBeUndefined();
    });
});
