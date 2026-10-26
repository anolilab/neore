import { describe, expect, it, vi } from "vitest";

import type { Fetch } from "../auth/grant";
import { CHAT_START_TIMEOUT_MS } from "./chat-api";
import { relayReply, splitLines } from "./stream";

const encoder = new TextEncoder();

/** A response whose body yields the given strings, one per read. */
const streamResponse = (parts: string[], status = 200): Response => {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const part of parts) {
                controller.enqueue(encoder.encode(part));
            }

            controller.close();
        },
    });

    return new Response(body, { status });
};

/** A fetch that never answers; it rejects only when its signal aborts. */
const hangingFetch: Fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });

const scripted = (responses: Response[]): { bodies: unknown[]; fetch: Fetch } => {
    const bodies: unknown[] = [];
    let call = 0;
    const fetch: Fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        const response = responses[call];

        call += 1;

        if (!response) {
            throw new Error("unexpected extra POST");
        }

        return response;
    };

    return { bodies, fetch };
};

describe("splitLines", () => {
    it("keeps an unfinished tail for the next read", () => {
        expect(splitLines('{"text":"a"}\n{"te')).toEqual({ lines: ['{"text":"a"}'], rest: '{"te' });
    });

    it("returns several lines from one read", () => {
        expect(splitLines('{"text":"a"}\n{"text":"b"}\n').lines).toHaveLength(2);
    });
});

describe("relayReply", () => {
    it("reassembles a line split across reads", async () => {
        const { fetch } = scripted([streamResponse(['{"te', 'xt":"Hel', 'lo"}\n', '{"type":"end"}\n'])]);
        const deltas: string[] = [];

        const outcome = await relayReply({
            fetch,
            gatewayUrl: "https://gw",
            onDelta: (delta) => {
                deltas.push(delta.text);
            },
            streamToken: "tok",
        });

        expect(outcome).toBe("finished");
        expect(deltas).toEqual(["Hello"]);
    });

    it("delivers several lines in one read and flushes a trailing line at done", async () => {
        const { fetch } = scripted([streamResponse(['{"text":"a"}\n{"text":"b"}\n{"text":"c"}'])]);
        const deltas: string[] = [];

        await relayReply({
            fetch,
            gatewayUrl: "https://gw",
            onDelta: (d) => {
                deltas.push(d.text);
            },
            streamToken: "tok",
        });

        expect(deltas).toEqual(["a", "b", "c"]);
    });

    it("on a resume marker, posts again with the counted lastChunkIndex", async () => {
        const { bodies, fetch } = scripted([
            streamResponse(['{"text":"a"}\n{"text":"b"}\n{"type":"resume","lastChunkIndex":2}\n']),
            streamResponse(['{"text":"c"}\n{"type":"end"}\n']),
        ]);
        const deltas: string[] = [];

        const outcome = await relayReply({
            fetch,
            gatewayUrl: "https://gw",
            onDelta: (d) => {
                deltas.push(d.text);
            },
            streamToken: "tok",
        });

        expect(outcome).toBe("finished");
        expect(deltas).toEqual(["a", "b", "c"]);
        expect(bodies[0]).toEqual({ endMarker: true, resumable: true, streamToken: "tok" });
        expect(bodies[1]).toEqual({ endMarker: true, lastChunkIndex: 2, resumable: true, streamToken: "tok" });
    });

    it("a relay that goes silent fails the reply after a minute, instead of waiting forever", async () => {
        vi.useFakeTimers();

        try {
            const silent = new ReadableStream<Uint8Array>({ start() {} });
            const { fetch } = scripted([new Response(silent, { status: 200 })]);

            const outcome = relayReply({ fetch, gatewayUrl: "https://gw", onDelta: () => {}, streamToken: "tok" });

            await vi.advanceTimersByTimeAsync(60_000);
            expect(await outcome).toBe("failed");
        } finally {
            vi.useRealTimers();
        }
    });

    it("a POST that never answers fails the reply once the deadline passes", async () => {
        vi.useFakeTimers();

        try {
            const outcome = relayReply({ fetch: hangingFetch, gatewayUrl: "https://gw", onDelta: () => {}, streamToken: "tok" });

            await vi.advanceTimersByTimeAsync(CHAT_START_TIMEOUT_MS);
            expect(await outcome).toBe("failed");
        } finally {
            vi.useRealTimers();
        }
    });

    it("the caller's abort cuts a pending POST and rejects instead of reporting a failed reply", async () => {
        const controller = new AbortController();
        const outcome = relayReply({ fetch: hangingFetch, gatewayUrl: "https://gw", onDelta: () => {}, signal: controller.signal, streamToken: "tok" });
        const rejected = expect(outcome).rejects.toThrow("aborted");

        controller.abort();
        await rejected;
    });

    it("a stream that closes without the end line or a resume marker fails the reply", async () => {
        const { fetch } = scripted([streamResponse(['{"text":"Hel"}\n{"text":"lo"}\n'])]);
        const deltas: string[] = [];

        const outcome = await relayReply({
            fetch,
            gatewayUrl: "https://gw",
            onDelta: (d) => {
                deltas.push(d.text);
            },
            streamToken: "tok",
        });

        expect(outcome).toBe("failed");
        expect(deltas).toEqual(["Hel", "lo"]);
    });

    it("a 205 means the stream already finished", async () => {
        const { fetch } = scripted([new Response(null, { status: 205 })]);

        expect(await relayReply({ fetch, gatewayUrl: "https://gw", onDelta: () => undefined, streamToken: "tok" })).toBe("finished");
    });

    it("an error line fails the reply", async () => {
        const { fetch } = scripted([streamResponse(['{"text":"a"}\n{"error":"boom"}\n'])]);
        const deltas: string[] = [];

        const outcome = await relayReply({
            fetch,
            gatewayUrl: "https://gw",
            onDelta: (d) => {
                deltas.push(d.text);
            },
            streamToken: "tok",
        });

        expect(outcome).toBe("failed");
        expect(deltas).toEqual(["a"]);
    });

    it("a non-ok status fails the reply", async () => {
        const { fetch } = scripted([new Response("nope", { status: 500 })]);

        expect(await relayReply({ fetch, gatewayUrl: "https://gw", onDelta: () => undefined, streamToken: "tok" })).toBe("failed");
    });
});
