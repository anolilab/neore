/**
 * Tool-call retry safety in the gateway stream adapter.
 *
 * The invariant: once a tool-call chunk has reached the caller, a stream
 * failure must not be silently retried on another model. Retrying after a tool
 * call risks duplicate side effects — DB writes, API mutations, payments.
 *
 * The gateway upholds this *structurally* rather than with a runtime guard,
 * and the structure is what these tests pin:
 *
 *   - `streamToSSE` never throws. Provider failures, whether delivered as an
 *     `error` part or as a rejection from the underlying iterator, come out as
 *     a typed `error` chunk. That is what lets the warm-up peek in
 *     `routes/internal/stream.ts` classify a failure and return 502 *before*
 *     committing to a 200 SSE response — the only point at which falling back
 *     to another model is safe, because nothing has been emitted yet.
 *
 *   - On `/v1/chat/completions` the typed fallback lives in the handler's
 *     outer catch, which can only run before the `Response` is returned. The
 *     streaming body is a `ReadableStream` whose `start()` has its own catch
 *     and does not execute until after the response is handed to the client,
 *     so a mid-stream failure can never reach the fallback path.
 *
 * If either of those shapes changes — an adapter that throws, or a fallback
 * moved inside the stream body — the invariant needs a real runtime guard and
 * these tests should start failing.
 */
import { describe, expect, it } from "vitest";

import { streamToSSE } from "../lib/stream-adapter.js";

const SSE_DATA_RE = /^data: (.+)\n\n$/;

// ---------------------------------------------------------------------------
// Helpers to build a minimal fake StreamTextResult
// ---------------------------------------------------------------------------

type FakeStreamPart =
    | { text: string; type: "text-delta" }
    | { text: string; type: "reasoning-delta" }
    | { input: { [argument: string]: string }; toolCallId: string; toolName: string; type: "tool-call" }
    | { type: "finish-step"; usage: { inputTokens: number; outputTokens: number } }
    | { type: "finish" }
    | { error: unknown; type: "error" };

function makeFakeResult(parts: FakeStreamPart[]) {
    // Minimal duck-type of StreamTextResult — only `fullStream` is needed by streamToSSE
    return {
        fullStream: (async function* generateParts() {
            for (const part of parts) {
                yield part;
            }
        })(),
    } as unknown as Parameters<typeof streamToSSE>[0];
}

/** A stream that fails partway through, after emitting a tool call. */
function makeFailingResult(parts: FakeStreamPart[], error: Error) {
    return {
        fullStream: (async function* fullStream() {
            for (const part of parts) {
                yield part;
            }

            throw error;
        })(),
    } as unknown as Parameters<typeof streamToSSE>[0];
}

const collect = async (iterable: AsyncIterable<string>): Promise<(Record<string, never> & { [key: string]: unknown; type: string })[]> => {
    const parsed: { [key: string]: unknown; type: string }[] = [];

    for await (const chunk of iterable) {
        const match = SSE_DATA_RE.exec(chunk);

        expect(match, `chunk is not SSE-framed: ${chunk}`).not.toBeNull();
        parsed.push(JSON.parse(match![1]!));
    }

    return parsed as (Record<string, never> & { [key: string]: unknown; type: string })[];
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("streamToSSE", () => {
    it("emits nothing tool-shaped for a pure text stream", async () => {
        const chunks = await collect(
            streamToSSE(
                makeFakeResult([
                    { text: "Hello", type: "text-delta" },
                    { text: " world", type: "text-delta" },
                ]),
            ),
        );

        expect(chunks.map((c) => c.type)).toEqual(["text-delta", "text-delta"]);
    });

    it("maps a tool-call part onto the gateway wire shape", async () => {
        const chunks = await collect(
            streamToSSE(makeFakeResult([{ input: { city: "Berlin" }, toolCallId: "tc-abc", toolName: "weather", type: "tool-call" }])),
        );

        expect(chunks).toEqual([{ args: { city: "Berlin" }, toolCallId: "tc-abc", toolName: "weather", type: "tool-call" }]);
    });

    it("defaults missing tool input to an empty object rather than undefined", async () => {
        const chunks = await collect(streamToSSE(makeFakeResult([{ toolCallId: "tc-1", toolName: "ping", type: "tool-call" } as FakeStreamPart])));

        expect(chunks[0]!.args).toEqual({});
    });

    it("preserves ordering around a tool call", async () => {
        const chunks = await collect(
            streamToSSE(
                makeFakeResult([
                    { text: "pre-tool text", type: "text-delta" },
                    { input: {}, toolCallId: "tc-1", toolName: "search", type: "tool-call" },
                    { text: "post-tool text", type: "text-delta" },
                ]),
            ),
        );

        expect(chunks.map((c) => c.type)).toEqual(["text-delta", "tool-call", "text-delta"]);
    });

    it("emits one chunk per tool call, not one per stream", async () => {
        const chunks = await collect(
            streamToSSE(
                makeFakeResult([
                    { input: {}, toolCallId: "tc-1", toolName: "search", type: "tool-call" },
                    { input: {}, toolCallId: "tc-2", toolName: "fetch", type: "tool-call" },
                ]),
            ),
        );

        expect(chunks.filter((c) => c.type === "tool-call").map((c) => c.toolCallId)).toEqual(["tc-1", "tc-2"]);
    });

    describe("failures never propagate as exceptions", () => {
        it("turns a provider error part into a typed error chunk", async () => {
            const chunks = await collect(streamToSSE(makeFakeResult([{ error: new Error("upstream exploded"), type: "error" }])));

            expect(chunks).toHaveLength(1);
            expect(chunks[0]!.type).toBe("error");
            expect((chunks[0]!.error as { code: string }).code).toBe("PROVIDER_ERROR");
        });

        it("turns a mid-stream rejection into a terminal error chunk, after the tool call it already emitted", async () => {
            // This is the case the invariant is about: the tool call is already
            // out. The adapter must not throw, because a throw is what would let
            // a caller treat the request as un-started and retry it.
            const chunks = await collect(
                streamToSSE(
                    makeFailingResult(
                        [{ input: { record: "important" }, toolCallId: "tc-1", toolName: "db_write", type: "tool-call" }],
                        new Error("connection reset"),
                    ),
                ),
            );

            expect(chunks.map((c) => c.type)).toEqual(["tool-call", "error"]);
            expect(chunks[1]!.error as { code: string; message: string }).toEqual({
                code: "STREAM_ERROR",
                message: "connection reset",
            });
        });

        it("reports a non-Error rejection without throwing", async () => {
            const chunks = await collect(streamToSSE(makeFailingResult([], "a bare string" as unknown as Error)));

            expect((chunks[0]!.error as { message: string }).message).toBe("Unknown stream error");
        });
    });
});
