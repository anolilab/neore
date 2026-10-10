import { afterEach, describe, expect, it, vi } from "vitest";

import { createStreamToken } from "../lib/stream-token.js";
import { clientStreamRouter, LONG_POLL_WAIT_MS, MAX_BACKEND_POLLS, POLL_FETCH_TIMEOUT_MS } from "../routes/v1/client-stream.js";

const SECRET = "test-signing-secret-32-bytes-long";

describe("POST /v1/stream chunk poll", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("gives each poll a deadline, not the client's abort signal, and ends the stream when it fires", async () => {
        const deadline = new AbortController();
        const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
        // A backend that never answers: only the signal can end the poll.
        const fetchMock = vi.fn(
            async (_url: string, init?: RequestInit) =>
                await new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        reject(new DOMException("timed out", "TimeoutError"));
                    });
                }),
        );

        vi.stubGlobal("fetch", fetchMock);

        const client = new AbortController();
        const response = await clientStreamRouter.request(
            "/v1/stream",
            {
                body: JSON.stringify({ streamToken: await createStreamToken("s1", "u1", "t1", SECRET) }),
                headers: { "content-type": "application/json" },
                method: "POST",
                signal: client.signal,
            },
            { LUNORA_URL: "https://backend.example", SIGNING_SECRET: SECRET },
        );

        await vi.waitFor(() => {
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        expect(timeout).toHaveBeenCalledWith(POLL_FETCH_TIMEOUT_MS);
        expect(fetchMock.mock.calls[0]![1]?.signal).toBe(deadline.signal);
        expect(fetchMock.mock.calls[0]![1]?.signal).not.toBe(client.signal);

        deadline.abort();

        await expect(response.text()).resolves.toBe(`${JSON.stringify({ error: "Stream relay error" })}\n`);
    });

    it("asks the backend to hold each poll, and re-polls a long-polled answer without sleeping", async () => {
        const replies = [
            { chunks: [], longPoll: true, status: "pending", totalChunks: 0 },
            { chunks: [{ text: "Hello" }], longPoll: true, status: "streaming", totalChunks: 1 },
            { chunks: [{ text: " world." }], longPoll: true, status: "done", totalChunks: 2 },
        ];
        const fetchMock = vi.fn(async () => Response.json(replies.shift()));
        const sleep = vi.spyOn(globalThis, "setTimeout");

        vi.stubGlobal("fetch", fetchMock);

        const response = await clientStreamRouter.request(
            "/v1/stream",
            {
                body: JSON.stringify({ streamToken: await createStreamToken("s1", "u1", "t1", SECRET) }),
                headers: { "content-type": "application/json" },
                method: "POST",
            },
            { LUNORA_URL: "https://backend.example", SIGNING_SECRET: SECRET },
        );

        await expect(response.text()).resolves.toBe(`${JSON.stringify({ text: "Hello" })}\n${JSON.stringify({ text: " world." })}\n`);

        const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>);

        expect(bodies.map((body) => body.afterIndex)).toStrictEqual([0, 0, 1]);
        expect(bodies.every((body) => body.waitMs === LONG_POLL_WAIT_MS)).toBe(true);
        expect(LONG_POLL_WAIT_MS).toBeLessThan(POLL_FETCH_TIMEOUT_MS);
        expect(sleep).not.toHaveBeenCalled();
    });

    it("falls back to interval polling against a backend that does not long-poll", async () => {
        const replies = [
            { chunks: [], status: "pending", totalChunks: 0 },
            { chunks: [{ text: "Hi." }], status: "done", totalChunks: 1 },
        ];
        const fetchMock = vi.fn(async () => Response.json(replies.shift()));

        vi.stubGlobal("fetch", fetchMock);

        const response = await clientStreamRouter.request(
            "/v1/stream",
            {
                body: JSON.stringify({ streamToken: await createStreamToken("s1", "u1", "t1", SECRET) }),
                headers: { "content-type": "application/json" },
                method: "POST",
            },
            { LUNORA_URL: "https://backend.example", SIGNING_SECRET: SECRET },
        );

        await expect(response.text()).resolves.toBe(`${JSON.stringify({ text: "Hi." })}\n`);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("hands a long stream across several requests, each under the subrequest cap, with every chunk exactly once", async () => {
        const TOTAL = 150;
        const FREE_PLAN_SUBREQUESTS = 50;
        const texts = Array.from({ length: TOTAL }, (_, index) => `w${String(index)} `);
        let written = 0;
        // A backend that writes one chunk per poll, and answers "done" with the last.
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            const { afterIndex } = JSON.parse(String(init?.body)) as { afterIndex: number };

            written = Math.min(TOTAL, written + 1);

            return Response.json({
                chunks: texts.slice(afterIndex, written).map((text) => {
                    return { text };
                }),
                longPoll: true,
                status: written === TOTAL ? "done" : "streaming",
                totalChunks: written,
            });
        });

        vi.stubGlobal("fetch", fetchMock);

        const token = await createStreamToken("s1", "u1", "t1", SECRET);
        const received: string[] = [];
        const pollsPerRequest: number[] = [];
        let lastChunkIndex: number | undefined;

        // The client side of the protocol: follow resume markers until the relay ends without one.
        for (let request = 0; request < 20; request += 1) {
            const before = fetchMock.mock.calls.length;
            const response = await clientStreamRouter.request(
                "/v1/stream",
                {
                    body: JSON.stringify({ resumable: true, streamToken: token, ...(lastChunkIndex !== undefined && { lastChunkIndex }) }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                },
                { LUNORA_URL: "https://backend.example", SIGNING_SECRET: SECRET },
            );
            const text = await response.text();
            const lines = text
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line) as { lastChunkIndex?: number; text?: string; type?: string });

            pollsPerRequest.push(fetchMock.mock.calls.length - before);

            const last = lines.at(-1);

            for (const line of lines) {
                if (line.type !== "resume") {
                    received.push(line.text ?? "");
                }
            }

            if (last?.type !== "resume") {
                break;
            }

            lastChunkIndex = last.lastChunkIndex;
            expect(lastChunkIndex).toBe(received.length);
        }

        expect(received.join("")).toBe(texts.join(""));
        expect(pollsPerRequest.length).toBeGreaterThanOrEqual(3);
        expect(Math.max(...pollsPerRequest)).toBeLessThanOrEqual(MAX_BACKEND_POLLS);
        expect(MAX_BACKEND_POLLS).toBeLessThan(FREE_PLAN_SUBREQUESTS);
    });

    it("never ends a stream with a resume marker for a client that did not ask for one", async () => {
        let polls = 0;
        const fetchMock = vi.fn(async () => {
            polls += 1;

            return Response.json({ chunks: [{ text: "x" }], longPoll: true, status: polls > MAX_BACKEND_POLLS + 5 ? "done" : "streaming", totalChunks: polls });
        });

        vi.stubGlobal("fetch", fetchMock);

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

        expect(body).not.toContain("resume");
        expect(fetchMock).toHaveBeenCalledTimes(MAX_BACKEND_POLLS + 6);
    });
});
