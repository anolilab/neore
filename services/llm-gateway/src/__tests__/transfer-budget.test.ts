/**
 * What one live reply sends the browser: the NDJSON the gateway relays from `POST /v1/stream`
 * for a single measured turn. The relay is the real route; the backend is a fake that serves
 * the fixture chunks in the shape the backend writes them (text deltas and tool progress).
 *
 * A live turn does not carry tool results: they are stored with the thread and reach the
 * client through the snapshot. So the fixture streams the reply text and one progress report
 * per write for the turn's tool calls, with the fields `ToolProgressChunk` carries.
 *
 * Decoded is the relayed body; wire is its gzip. Lines are NDJSON lines. The result is written
 * to `NEORE_TRANSFER_BUDGET_DIR/stream.json` only when that variable is set (the
 * `thread-transfer` workflow sets it), and the ceilings below fail the test when exceeded.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createStreamToken } from "../lib/stream-token.js";
import { clientStreamRouter } from "../routes/v1/client-stream.js";

const SECRET = "test-signing-secret-32-bytes-long"; // gitleaks:allow: test-only signing key, as in the sibling tests
/** Chunks the fake backend hands back per poll, as a long-poll answer would. */
const CHUNKS_PER_POLL = 25;
const MEASURED_TOOL_CALLS = 20;
const REPLY_CHUNKS = 60;
const REPLY_CHUNK_CHARS = 100;
const LIVE_SCENARIO_ID = "thread-transfer-live-v1";

// Ceilings: the measured value plus about 25% headroom. Raise one only with a reason in the PR.
const CEILING = {
    liveStreamDecodedBytes: 12_500,
    liveStreamMessages: 100,
    liveStreamWireBytes: 650,
};

/** The chunks one turn writes, in the order the backend writes them. */
const measuredTurnChunks = (): Record<string, unknown>[] => {
    const progress = Array.from({ length: MEASURED_TOOL_CALLS }, (_, call) => {
        return {
            toolProgress: {
                message: `searching the index for lookup ${String(call)}`,
                progress: call,
                serverName: "docs",
                toolCallId: `call-${String(call)}`,
                toolName: "docs_search",
                total: MEASURED_TOOL_CALLS,
            },
        };
    });
    const text = Array.from({ length: REPLY_CHUNKS }, (_, index) => {
        return { text: `${String(index).padStart(3, "0")} ${"lorem ipsum dolor sit amet ".repeat(4)}`.slice(0, REPLY_CHUNK_CHARS) };
    });

    return [...progress, ...text];
};

/** A fake backend `/chat/chunks` that answers each poll with the next slice, the way a long-poll does. */
const fakeBackend = (chunks: Record<string, unknown>[]) =>
    vi.fn(async (_url: string, init?: RequestInit) => {
        const { afterIndex } = JSON.parse(String(init?.body)) as { afterIndex: number };
        const slice = chunks.slice(afterIndex, afterIndex + CHUNKS_PER_POLL);
        const totalChunks = chunks.length;

        return Response.json({
            chunks: slice,
            longPoll: true,
            status: afterIndex + slice.length >= totalChunks ? "done" : "streaming",
            totalChunks,
        });
    });

describe("live reply transfer", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("keeps one measured live turn within its decoded, wire and line ceilings", async () => {
        const chunks = measuredTurnChunks();

        vi.stubGlobal("fetch", fakeBackend(chunks));

        const response = await clientStreamRouter.request(
            "/v1/stream",
            {
                body: JSON.stringify({ streamToken: await createStreamToken("s1", "u1", "t1", SECRET) }),
                headers: { "content-type": "application/json" },
                method: "POST",
            },
            { LUNORA_URL: "https://backend.example", SIGNING_SECRET: SECRET },
        );
        const body = await response.text();
        const bytes = Buffer.from(body);
        const observed = {
            liveStreamDecodedBytes: bytes.byteLength,
            liveStreamMessages: body.split("\n").filter((line) => line.length > 0).length,
            liveStreamWireBytes: gzipSync(bytes).byteLength,
        };

        if (process.env.NEORE_TRANSFER_BUDGET_DIR) {
            mkdirSync(process.env.NEORE_TRANSFER_BUDGET_DIR, { recursive: true });
            writeFileSync(
                join(process.env.NEORE_TRANSFER_BUDGET_DIR, "stream.json"),
                `${JSON.stringify(
                    {
                        ceiling: CEILING,
                        observed,
                        scenario: {
                            id: LIVE_SCENARIO_ID,
                            measuredToolCalls: MEASURED_TOOL_CALLS,
                            replyChunkChars: REPLY_CHUNK_CHARS,
                            replyChunks: REPLY_CHUNKS,
                        },
                        schemaVersion: 1,
                    },
                    null,
                    2,
                )}\n`,
            );
        }

        // Every chunk is relayed exactly once: one NDJSON line per chunk.
        expect(observed.liveStreamMessages).toBe(chunks.length);
        expect(observed.liveStreamWireBytes).toBeLessThanOrEqual(CEILING.liveStreamWireBytes);
        expect(observed.liveStreamDecodedBytes).toBeLessThanOrEqual(CEILING.liveStreamDecodedBytes);
        expect(observed.liveStreamMessages).toBeLessThanOrEqual(CEILING.liveStreamMessages);
    });
});
