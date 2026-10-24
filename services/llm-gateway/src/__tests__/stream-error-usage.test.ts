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
import { PricingService } from "../providers/pricing.js";
import { UsageReporter } from "../usage/reporter.js";
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

/**
 * "Stop generating" cancels the relay before the provider's `finish` part, so no
 * real usage arrives. The prompt and the text already streamed were still
 * produced, so they are billed on an estimate (chars / 4) with finishReason "cancelled".
 */
describe("a cancelled stream bills the tokens it already produced", () => {
    const PROMPT = "x".repeat(400); // 100 tokens
    const DELTA = "y".repeat(20); // two of them: 40 chars, 10 tokens
    // U+2028 is a line terminator for `.` but not for JSON.stringify, so it reaches the SSE frame raw.
    const SEPARATED_DELTA = `${"y".repeat(9)}\u{2028}${"y".repeat(10)}`;

    let recordSpy: ReturnType<typeof vi.spyOn>;
    let reportSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        recordSpy = vi.spyOn(UsageTracker.prototype, "record");
        reportSpy = vi.spyOn(UsageReporter.prototype, "report").mockResolvedValue(true);
        vi.spyOn(PricingService.prototype, "getPricing").mockResolvedValue({ inputPerMillion: 1, outputPerMillion: 2 });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.mocked(streamText).mockReset();
        vi.mocked(createProviderModelForEnv).mockReset();
    });

    /** Reads two SSE events, then cancels the body the way an aborted backend fetch does. */
    const readTwoThenCancel = async (res: Response): Promise<void> => {
        const reader = res.body!.getReader();

        await reader.read();
        await reader.read();
        await reader.cancel("user stopped");
    };

    /** The usage entry and the usage report, once the background record has run. */
    const billed = async (): Promise<{ entry: UsageLogEntry | undefined; report: unknown }> => {
        await vi.waitFor(() => expect(reportSpy).toHaveBeenCalled());

        return { entry: recordedEntries(recordSpy)[0], report: reportSpy.mock.calls[0]?.[0] };
    };

    const ESTIMATED_ENTRY = { completionTokens: 10, finishReason: "cancelled", promptTokens: 100 };
    // 100 prompt tokens at $1/M + 10 completion tokens at $2/M = 120 microdollars.
    const ESTIMATED_REPORT = { completionTokens: 10, costMicrodollars: 120, promptTokens: 100 };

    it("POST /internal/model/proxy records the estimate when cancelled before finish", async () => {
        vi.mocked(createProviderModelForEnv).mockResolvedValueOnce({
            doStream: async () => {
                return {
                    // Two deltas, then the provider keeps the stream open: the cancel ends it.
                    stream: new ReadableStream({
                        start(controller) {
                            controller.enqueue({ delta: DELTA, id: "t1", type: "text-delta" });
                            controller.enqueue({ delta: DELTA, id: "t1", type: "text-delta" });
                        },
                    }),
                };
            },
        } as never);

        const res = await fetchApp(
            new Request("http://localhost/internal/model/proxy", {
                body: JSON.stringify({
                    action: "stream",
                    callOptions: { prompt: [{ content: [{ text: PROMPT, type: "text" }], role: "user" }] },
                    modelApiId: "gpt-test-1",
                    modelId: "gpt-test",
                    provider: "openai",
                    requestId: "req-proxy-cancel",
                    userId: "user-1",
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            }),
            bindingEnv(createMockEnv()),
        );

        await readTwoThenCancel(res);
        const { entry, report } = await billed();

        expect(entry).toMatchObject(ESTIMATED_ENTRY);
        expect(entry).not.toHaveProperty("errorCode");
        expect(report).toMatchObject(ESTIMATED_REPORT);
    });

    it("POST /internal/model/proxy bills a completed tool call's arguments when cancelled before finish", async () => {
        const args = JSON.stringify({ query: "z".repeat(40) });

        vi.mocked(createProviderModelForEnv).mockResolvedValueOnce({
            doStream: async () => {
                return {
                    stream: new ReadableStream({
                        start(controller) {
                            controller.enqueue({ input: args, toolCallId: "call-1", toolName: "search", type: "tool-call" });
                        },
                    }),
                };
            },
        } as never);

        const res = await fetchApp(
            new Request("http://localhost/internal/model/proxy", {
                body: JSON.stringify({
                    action: "stream",
                    callOptions: { prompt: [{ content: [{ text: PROMPT, type: "text" }], role: "user" }] },
                    modelApiId: "gpt-test-1",
                    modelId: "gpt-test",
                    provider: "openai",
                    requestId: "req-proxy-tool-cancel",
                    userId: "user-1",
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            }),
            bindingEnv(createMockEnv()),
        );

        const reader = res.body!.getReader();

        await reader.read();
        await reader.cancel("user stopped");

        const { entry } = await billed();

        expect(entry).toMatchObject({ completionTokens: Math.ceil(args.length / 4), finishReason: "cancelled" });
    });

    /** A `streamText` that yields `parts`, then stays open until the request is aborted, as a cancelled stream does. */
    const streamTextUntilAborted = (parts: object[], { failOnAbort = false } = {}) =>
        (({ abortSignal }: { abortSignal: AbortSignal }) => {
            const aborted = new Promise<void>((resolve) => {
                abortSignal.addEventListener("abort", () => resolve(), { once: true });
            });
            // AI SDK rejects its result promises when a stream is aborted before any step finished.
            const rejectOnAbort = aborted.then(() => {
                throw new Error("aborted");
            });

            rejectOnAbort.catch(() => undefined);

            return {
                finishReason: rejectOnAbort,
                fullStream: (async function* partsOf() {
                    yield* parts;
                    await aborted;

                    if (failOnAbort) {
                        throw new Error("aborted mid-iteration");
                    }
                })(),
                usage: rejectOnAbort,
            };
        }) as never;

    it("POST /internal/stream bills a completed tool call's arguments when cancelled before finish", async () => {
        const input = { query: "z".repeat(40) };

        vi.mocked(streamText).mockImplementationOnce(streamTextUntilAborted([{ input, toolCallId: "call-1", toolName: "search", type: "tool-call" }]));
        vi.mocked(createProviderModelForEnv).mockResolvedValueOnce({} as never);

        const res = await fetchApp(
            new Request("http://localhost/internal/stream", {
                body: JSON.stringify({
                    messages: [{ content: PROMPT, role: "user" }],
                    modelApiId: "gpt-test-1",
                    modelId: "gpt-test",
                    provider: "openai",
                    requestId: "req-stream-tool-cancel",
                    userId: "user-1",
                    warmupTimeoutMs: 0,
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            }),
            bindingEnv(createMockEnv()),
        );

        const reader = res.body!.getReader();

        await reader.read();
        await reader.cancel("user stopped");

        const { entry } = await billed();

        expect(entry).toMatchObject({ completionTokens: Math.ceil(JSON.stringify(input).length / 4), finishReason: "cancelled" });
    });

    it("POST /internal/stream does not tag a cancelled stream as a provider failure when its iteration throws on abort", async () => {
        vi.mocked(streamText).mockImplementationOnce(streamTextUntilAborted([{ text: DELTA, type: "text-delta" }], { failOnAbort: true }));
        vi.mocked(createProviderModelForEnv).mockResolvedValueOnce({} as never);

        const res = await fetchApp(
            new Request("http://localhost/internal/stream", {
                body: JSON.stringify({
                    messages: [{ content: PROMPT, role: "user" }],
                    modelApiId: "gpt-test-1",
                    modelId: "gpt-test",
                    provider: "openai",
                    requestId: "req-stream-abort-error",
                    userId: "user-1",
                    warmupTimeoutMs: 0,
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            }),
            bindingEnv(createMockEnv()),
        );

        const reader = res.body!.getReader();

        await reader.read();
        await reader.cancel("user stopped");

        const { entry } = await billed();

        expect(entry).toMatchObject({ finishReason: "cancelled" });
        expect(entry).not.toHaveProperty("errorCode");
    });

    it.each([
        ["a plain delta", DELTA],
        ["a delta with a U+2028 line separator", SEPARATED_DELTA],
    ])("POST /internal/stream records the estimate when cancelled before finish (%s)", async (_label, delta) => {
        vi.mocked(streamText).mockImplementationOnce(
            streamTextUntilAborted([
                { text: delta, type: "text-delta" },
                { text: delta, type: "text-delta" },
            ]),
        );
        vi.mocked(createProviderModelForEnv).mockResolvedValueOnce({} as never);

        const res = await fetchApp(
            new Request("http://localhost/internal/stream", {
                body: JSON.stringify({
                    messages: [{ content: PROMPT, role: "user" }],
                    modelApiId: "gpt-test-1",
                    modelId: "gpt-test",
                    provider: "openai",
                    requestId: "req-stream-cancel",
                    userId: "user-1",
                    warmupTimeoutMs: 0,
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            }),
            bindingEnv(createMockEnv()),
        );

        await readTwoThenCancel(res);
        const { entry, report } = await billed();

        expect(entry).toMatchObject(ESTIMATED_ENTRY);
        expect(entry).not.toHaveProperty("errorCode");
        expect(report).toMatchObject(ESTIMATED_REPORT);
    });
});
