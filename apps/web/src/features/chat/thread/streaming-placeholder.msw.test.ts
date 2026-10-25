// @vitest-environment node

/**
 * `startStreaming` against a mocked gateway (msw), for the cases hand-written
 * `fetch` stubs cannot express: chunks that arrive over time, a connection that
 * drops mid-stream, a lock, a rate limit, and an abort in flight. Node
 * environment: msw intercepts Node's fetch, and the abort signal must be a real
 * one.
 */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { startStreaming } from "./streaming-placeholder";

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {};
        },
    };
});

const GATEWAY = "https://gateway.test/v1/stream";
const encoder = new TextEncoder();
const line = (text: string) => `${JSON.stringify({ text })}\n`;
const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });

/** A body that emits one line per pull, `gapMs` apart; `failAfter` errors after that many lines. */
const linesStream = (lines: string[], options: { failAfter?: number; gapMs?: number } = {}) => {
    let index = 0;

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (options.failAfter !== undefined && index === options.failAfter) {
                controller.error(new Error("connection reset"));

                return;
            }

            if (index >= lines.length) {
                controller.close();

                return;
            }

            if (options.gapMs) {
                await sleep(options.gapMs);
            }

            controller.enqueue(encoder.encode(line(lines[index] ?? "")));
            index += 1;
        },
    });
};

const server = setupServer();

beforeAll(() => {
    server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
    server.resetHandlers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

afterAll(() => {
    server.close();
});

const start = (options: { onReconnecting?: (attempt: number) => void; onUpdate?: (text: string) => void; signal?: AbortSignal } = {}) => {
    let text = "";

    return startStreaming(
        new URL(GATEWAY),
        "s1" as never,
        (delta) => {
            text += delta.text;
            options.onUpdate?.(delta.text);
        },
        {},
        undefined,
        options.onReconnecting,
        "token",
        options.signal ?? new AbortController().signal,
    ).then((done) => {
        return { done, text };
    });
};

describe(startStreaming, () => {
    it("delivers chunks that arrive over time, in order, to the end of the stream", async () => {
        const words = ["one ", "two ", "three"];

        server.use(http.post(GATEWAY, () => new HttpResponse(linesStream(words, { gapMs: 5 }), { headers: { "content-type": "application/x-ndjson" } })));

        const { done, text } = await start();

        expect(done).toBe(true);
        expect(text).toBe(words.join(""));
    });

    it("reconnects after a mid-stream drop, continuing from the chunks already delivered", async () => {
        const words = ["a ", "b ", "c ", "d ", "e"];
        const bodies: { lastChunkIndex?: number }[] = [];
        const onReconnecting = vi.fn();

        // msw's interceptor closes a body that errors rather than passing the error
        // on, so a drop is simulated at `fetch`: the first response fails after three lines.
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: URL, init?: RequestInit) => {
                const body = JSON.parse(String(init?.body)) as { lastChunkIndex?: number };
                const resumedAt = body.lastChunkIndex ?? 0;

                bodies.push(body);

                return new Response(linesStream(words.slice(resumedAt), resumedAt === 0 ? { failAfter: 3 } : {}) as never, { status: 200 });
            }),
        );

        const { done, text } = await start({ onReconnecting });

        expect(done).toBe(true);
        expect(text).toBe(words.join(""));
        expect(onReconnecting).toHaveBeenCalledWith(1);
        expect(bodies.map((body) => body.lastChunkIndex)).toEqual([undefined, 3]);
    });

    it("stops at once on a thread lock, without reconnecting", async () => {
        const onReconnecting = vi.fn();
        let requests = 0;

        server.use(
            http.post(GATEWAY, () => {
                requests += 1;

                return HttpResponse.json({ code: "THREAD_LOCKED", error: "This chat is locked." }, { status: 403 });
            }),
        );

        const { done, text } = await start({ onReconnecting });

        expect(done).toBe(false);
        expect(text).toBe("");
        expect(requests).toBe(1);
        expect(onReconnecting).not.toHaveBeenCalled();
    });

    it("stops at once on a rate limit, without reconnecting", async () => {
        const onReconnecting = vi.fn();
        let requests = 0;

        server.use(
            http.post(GATEWAY, () => {
                requests += 1;

                return HttpResponse.json({ error: { code: "RATE_LIMITED" } }, { status: 429, headers: { "Retry-After": "30" } });
            }),
        );

        const { done } = await start({ onReconnecting });

        expect(done).toBe(false);
        expect(requests).toBe(1);
        expect(onReconnecting).not.toHaveBeenCalled();
    });

    it("returns at once when the caller aborts mid-stream", async () => {
        const controller = new AbortController();
        let received = "";

        server.use(
            http.post(GATEWAY, () => {
                // Delivers one chunk, then holds the body open until the client gives up.
                const body = new ReadableStream<Uint8Array>({
                    start(streamController) {
                        streamController.enqueue(encoder.encode(line("first")));
                    },
                });

                return new HttpResponse(body, { headers: { "content-type": "application/x-ndjson" } });
            }),
        );

        const pending = start({
            onUpdate: (chunk) => {
                received += chunk;
                controller.abort();
            },
            signal: controller.signal,
        });

        const { done, text } = await pending;

        expect(done).toBe(false);
        expect(text).toBe("first");
        expect(received).toBe("first");
    });
});
