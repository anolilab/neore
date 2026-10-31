/**
 * A provider rate limit on `/internal/model/proxy` reaches the backend as structured
 * data (`rateLimit: { status, retryAt }`) next to `fallbackReason`, on each of the
 * three ways a call can fail: the rejection of the call itself (a 502 body), an
 * `error` part the provider sent in-band, and a stream that throws while being read.
 * The backend decides on these fields and never on message text.
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

interface RateLimit {
    retryAt?: number;
    status: number;
}

/** A provider rejection shaped like the AI SDK's `APICallError`. */
const providerError = (statusCode: number, headers: Record<string, string> = {}, responseBody = "") =>
    Object.assign(new Error(responseBody || "rejected"), { responseBody, responseHeaders: headers, statusCode });

const post = async (action: "generate" | "stream", doCall: () => Promise<unknown>) => {
    vi.mocked(createProviderModelForEnv).mockResolvedValueOnce({ doGenerate: doCall, doStream: doCall } as never);

    return await fetchApp(
        new Request("http://localhost/internal/model/proxy", {
            body: JSON.stringify({
                action,
                callOptions: { prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }] },
                modelApiId: "gemini-2.5-flash",
                modelId: "gemini-2.5-flash",
                provider: "google",
                requestId: "req-rate-limit-1",
                userId: "user-1",
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        }),
        bindingEnv(createMockEnv()),
    );
};

const eventsOf = async (response: Response) => {
    const text = await response.text();

    return text
        .split("\n\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as { rateLimit?: RateLimit; type: string });
};

const streamOf = (parts: unknown[], failWith?: Error) => async () => {
    return {
        stream: new ReadableStream({
            pull(controller) {
                const part = parts.shift();

                if (part !== undefined) {
                    controller.enqueue(part);

                    return;
                }

                if (failWith) {
                    controller.error(failWith);

                    return;
                }

                controller.close();
            },
        }),
    };
};

describe("POST /internal/model/proxy reports a provider rate limit", () => {
    afterEach(() => {
        vi.mocked(createProviderModelForEnv).mockReset();
    });

    describe("when the call itself is rejected", () => {
        it.each(["generate", "stream"] as const)("%s: a 429 with retry-after carries the provider's retry time", async (action) => {
            const before = Date.now();
            const response = await post(action, async () => {
                throw providerError(429, { "retry-after": "42" });
            });
            const body = (await response.json()) as { error: { fallbackReason?: string; rateLimit?: RateLimit } };

            expect(response.status).toBe(502);
            expect(body.error.rateLimit?.status).toBe(429);
            expect(body.error.rateLimit?.retryAt).toBeGreaterThanOrEqual(before + 42_000);
            expect(body.error.rateLimit?.retryAt).toBeLessThanOrEqual(Date.now() + 42_000);
            // Alongside, not instead of, the classification the backup-model switch reads.
            expect(body.error.fallbackReason).toBe("infra");
        });

        it("reads Google's body field when the response has no header", async () => {
            const responseBody = JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "20s" }] } });
            const response = await post("stream", async () => {
                throw providerError(429, {}, responseBody);
            });
            const body = (await response.json()) as { error: { rateLimit?: RateLimit } };

            expect(body.error.rateLimit?.status).toBe(429);
            expect(body.error.rateLimit?.retryAt).toBeGreaterThan(Date.now() + 15_000);
        });

        it("a bare 429 is a rate limit with no retry time", async () => {
            const response = await post("generate", async () => {
                throw providerError(429);
            });
            const body = (await response.json()) as { error: { rateLimit?: RateLimit } };

            expect(body.error.rateLimit).toEqual({ status: 429 });
        });

        it.each([401, 403, 404, 500])("a %s is not a rate limit", async (statusCode) => {
            const response = await post("generate", async () => {
                throw providerError(statusCode);
            });
            const body = (await response.json()) as { error: { rateLimit?: RateLimit } };

            expect(body.error.rateLimit).toBeUndefined();
        });
    });

    describe("on an error part the provider sent in-band", () => {
        it("before any content carries the rate limit", async () => {
            const events = await eventsOf(
                await post(
                    "stream",
                    streamOf([
                        { type: "stream-start", warnings: [] },
                        { error: providerError(429, { "retry-after": "5" }), type: "error" },
                    ]),
                ),
            );

            expect(events.find((event) => event.type === "error")?.rateLimit?.status).toBe(429);
            expect(events.find((event) => event.type === "error")?.rateLimit?.retryAt).toBeGreaterThan(Date.now());
        });

        it("after content has gone out carries none, so the run fails instead of repeating text", async () => {
            const events = await eventsOf(
                await post(
                    "stream",
                    streamOf([
                        { delta: "hi", id: "1", type: "text-delta" },
                        { error: providerError(429, { "retry-after": "5" }), type: "error" },
                    ]),
                ),
            );

            expect(events.find((event) => event.type === "error")?.rateLimit).toBeUndefined();
        });
    });

    describe("when the stream throws while being read", () => {
        it("before any content carries the rate limit", async () => {
            const events = await eventsOf(await post("stream", streamOf([{ type: "stream-start", warnings: [] }], providerError(429, { "retry-after": "9" }))));
            const error = events.find((event) => event.type === "error");

            expect(error?.rateLimit?.status).toBe(429);
            expect(error?.rateLimit?.retryAt).toBeGreaterThan(Date.now() + 5000);
        });

        it("after content carries none", async () => {
            const events = await eventsOf(
                await post("stream", streamOf([{ delta: "hi", id: "1", type: "text-delta" }], providerError(429, { "retry-after": "9" }))),
            );

            expect(events.find((event) => event.type === "error")?.rateLimit).toBeUndefined();
        });
    });
});
