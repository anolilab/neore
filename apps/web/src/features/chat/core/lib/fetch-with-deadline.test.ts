// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { TimeoutError } from "@/lib/errors";

import { fetchWithDeadline } from "./fetch-with-deadline";
import { startMediaGeneration } from "./start-media-generation";

/** A fetch that never answers but honours its abort signal, like the real one. */
const stalledFetch = () =>
    vi.fn(
        (_url: unknown, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    reject(init.signal?.reason);
                });
            }),
    );

describe("fetchWithDeadline", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("returns the response with its body", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: 1 }, { status: 201 })));

        const response = await fetchWithDeadline("https://gateway.test/v1/chat", { method: "POST" });

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toStrictEqual({ ok: 1 });
    });

    it("rejects with a TimeoutError when the gateway never answers", async () => {
        vi.stubGlobal("fetch", stalledFetch());

        await expect(fetchWithDeadline("https://gateway.test/v1/chat", {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError);
    });

    it("rejects with a TimeoutError when the body stalls after the headers", async () => {
        // Headers arrive, the body never does; aborting the request errors the stream, as in a browser.
        vi.stubGlobal(
            "fetch",
            vi.fn((_url: unknown, init?: RequestInit) => {
                const body = new ReadableStream({
                    start(controller) {
                        init?.signal?.addEventListener("abort", () => {
                            controller.error(init.signal?.reason);
                        });
                    },
                });

                return Promise.resolve(new Response(body));
            }),
        );

        await expect(fetchWithDeadline("https://gateway.test/v1/chat", {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError);
    });

    it("rethrows a caller abort unchanged instead of reporting a timeout", async () => {
        vi.stubGlobal("fetch", stalledFetch());

        const controller = new AbortController();
        const pending = fetchWithDeadline("https://gateway.test/v1/chat", {}, { signal: controller.signal, timeoutMs: 5000 });

        controller.abort(new DOMException("cancelled", "AbortError"));

        const error = await pending.catch((error_: unknown) => error_);

        expect(error).not.toBeInstanceOf(TimeoutError);
        expect((error as DOMException).name).toBe("AbortError");
    });
});

describe("startMediaGeneration deadline", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("turns a stalled gateway into the network failure so the caller clears its state", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", stalledFetch());

        const pending = startMediaGeneration({ body: {}, headers: {}, url: "https://gateway.test/v1/chat/media" });

        await vi.advanceTimersByTimeAsync(31_000);

        await expect(pending).resolves.toMatchObject({ cause: expect.any(TimeoutError), kind: "network", ok: false });
    });
});
