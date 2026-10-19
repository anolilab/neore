/**
 * A provider error inside a streamed reply is recorded as a failed call: the
 * usage entry carries `errorCode`, so `recordGenAiSpan` exports the span with an
 * error status instead of OK. A stream that finishes cleanly carries no code.
 *
 * Covers the two internal stream routes the backend calls (`/internal/model/proxy`
 * and `/internal/stream`), driven through the real app with the binding env.
 */
import { streamText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProviderModelForEnv } from "../providers/factory.js";
import type { UsageLogEntry } from "../usage/tracker.js";
import { UsageTracker } from "../usage/tracker.js";
import { bindingEnv } from "./helpers/internal.js";
import { createMockEnv } from "./helpers/mock-env.js";
import { useTrackedAppFetch } from "./helpers/tracked-app-fetch.js";

vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), streamText: vi.fn() };
});

vi.mock("../providers/factory.js", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../providers/factory.js")>()),
        createProviderModelForEnv: vi.fn(),
        resolveApiKey: vi.fn().mockReturnValue("test-api-key"),
    };
});

const fetchApp = useTrackedAppFetch();

const usage = { inputTokens: { cacheRead: 0, total: 10 }, outputTokens: { reasoning: 0, total: 5 } };

/** A model stream: some text, optionally a provider error, then the finish part. */
const modelParts = (hasError: boolean) => {
    const parts: unknown[] = [{ delta: "partial", id: "t1", type: "text-delta" }];

    if (hasError) {
        parts.push({ error: new Error("provider exploded"), type: "error" });
    }

    parts.push({ finishReason: { raw: "stop", unified: "stop" }, type: "finish", usage });

    return parts;
};

const readable = (parts: unknown[]) =>
    new ReadableStream({
        start(controller) {
            for (const part of parts) controller.enqueue(part);

            controller.close();
        },
    });

/** A `streamText` result whose full stream carries the given parts. */
const streamTextResult = (hasError: boolean) => {
    const parts = [
        { text: "partial", type: "text-delta" },
        ...(hasError ? [{ error: new Error("provider exploded"), type: "error" }] : []),
        { text: "", type: "text-delta" },
    ];

    return {
        finishReason: Promise.resolve("stop"),
        fullStream: (async function* partsOf() {
            for (const part of parts) yield part;
        })(),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    };
};

const recordedEntries = (spy: ReturnType<typeof vi.spyOn>): UsageLogEntry[] => (spy.mock.calls as [UsageLogEntry, unknown?][]).map(([entry]) => entry);

describe("streamed provider errors are recorded as failed calls", () => {
    let recordSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        recordSpy = vi.spyOn(UsageTracker.prototype, "record");
    });

    afterEach(() => {
        recordSpy.mockRestore();
        vi.mocked(streamText).mockReset();
        vi.mocked(createProviderModelForEnv).mockReset();
    });

    describe("POST /internal/model/proxy (action: stream)", () => {
        const proxy = (hasError: boolean) => {
            vi.mocked(createProviderModelForEnv).mockResolvedValueOnce({
                doStream: async () => {
                    return { stream: readable(modelParts(hasError)) };
                },
            } as never);

            return fetchApp(
                new Request("http://localhost/internal/model/proxy", {
                    body: JSON.stringify({
                        action: "stream",
                        callOptions: { prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }] },
                        modelApiId: "gpt-test-1",
                        modelId: "gpt-test",
                        provider: "openai",
                        requestId: "req-proxy-1",
                        userId: "user-1",
                    }),
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                }),
                bindingEnv(createMockEnv()),
            );
        };

        it("tags the usage entry with errorCode when the stream carries an error part", async () => {
            const res = await proxy(true);

            await res.text();

            const [entry] = recordedEntries(recordSpy);

            expect(entry?.errorCode).toBe("PROVIDER_ERROR");
        });

        it("leaves errorCode off a stream that finishes cleanly", async () => {
            const res = await proxy(false);

            await res.text();

            const [entry] = recordedEntries(recordSpy);

            expect(entry).toBeDefined();
            expect(entry).not.toHaveProperty("errorCode");
        });
    });

    describe("POST /internal/stream", () => {
        const stream = (hasError: boolean) => {
            vi.mocked(streamText).mockReturnValueOnce(streamTextResult(hasError) as never);
            vi.mocked(createProviderModelForEnv).mockResolvedValueOnce({} as never);

            return fetchApp(
                new Request("http://localhost/internal/stream", {
                    body: JSON.stringify({
                        messages: [{ content: "hi", role: "user" }],
                        modelApiId: "gpt-test-1",
                        modelId: "gpt-test",
                        provider: "openai",
                        requestId: "req-stream-1",
                        userId: "user-1",
                        warmupTimeoutMs: 0,
                    }),
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                }),
                bindingEnv(createMockEnv()),
            );
        };

        it("tags the usage entry with errorCode when the stream carries an error part", async () => {
            const res = await stream(true);

            await res.text();

            const [entry] = recordedEntries(recordSpy);

            expect(entry?.errorCode).toBe("PROVIDER_ERROR");
        });

        it("leaves errorCode off a stream that finishes cleanly", async () => {
            const res = await stream(false);

            await res.text();

            const [entry] = recordedEntries(recordSpy);

            expect(entry).toBeDefined();
            expect(entry).not.toHaveProperty("errorCode");
        });
    });
});
