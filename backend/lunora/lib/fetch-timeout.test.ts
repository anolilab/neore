import { afterEach, describe, expect, it, vi } from "vitest";

import { assertOk, FETCH_TIMEOUT_MS, fetchOk, fetchWithDeadline, HTTP_ERROR_BODY_MAX_CHARS, HttpError } from "./fetch-timeout";

/** A fetch that never answers on its own and rejects only when its signal aborts. */
const hangingFetch = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
);

describe(fetchWithDeadline, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        hangingFetch.mockClear();
    });

    it("aborts a request that outlives its deadline", async () => {
        expect.assertions(1);

        vi.stubGlobal("fetch", hangingFetch);

        await expect(fetchWithDeadline("https://example.test", { timeoutMs: 10 })).rejects.toMatchObject({ name: "TimeoutError" });
    });

    it("always passes a signal, even when the caller gives none", async () => {
        expect.assertions(2);

        const fetchSpy = vi.fn(async () => new Response("ok"));

        vi.stubGlobal("fetch", fetchSpy);

        await fetchWithDeadline("https://example.test");

        const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];

        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.signal?.aborted).toBe(false);
    });

    it("keeps a caller-supplied signal working alongside the deadline", async () => {
        expect.assertions(1);

        vi.stubGlobal("fetch", hangingFetch);

        const controller = new AbortController();
        const pending = fetchWithDeadline("https://example.test", { signal: controller.signal, timeoutMs: FETCH_TIMEOUT_MS });

        controller.abort(new Error("cancelled by caller"));

        await expect(pending).rejects.toThrow("cancelled by caller");
    });

    it("does not forward timeoutMs to fetch", async () => {
        expect.assertions(1);

        const fetchSpy = vi.fn(async () => new Response("ok"));

        vi.stubGlobal("fetch", fetchSpy);

        await fetchWithDeadline("https://example.test", { method: "POST", timeoutMs: 1000 });

        const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit & { timeoutMs?: number }])[1];

        expect(init).not.toHaveProperty("timeoutMs");
    });
});

/** A response whose body records whether it was cancelled. */
const trackedResponse = (status: number, statusText: string, text = "error body") => {
    const state = { cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
        cancel: () => {
            state.cancelled = true;
        },
        start: (controller) => {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });

    return { response: new Response(stream, { status, statusText }), state };
};

describe(assertOk, () => {
    it("returns an OK response untouched", async () => {
        expect.assertions(1);

        const response = new Response("fine");

        await expect(assertOk(response)).resolves.toBe(response);
    });

    it("cancels the body and throws an HttpError with the hand-written message shape", async () => {
        expect.assertions(3);

        const { response, state } = trackedResponse(503, "Service Unavailable");
        const error = await assertOk(response, "Tavily API error").catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(HttpError);
        expect(error).toMatchObject({ body: undefined, message: "Tavily API error: 503 Service Unavailable", status: 503, statusText: "Service Unavailable" });
        expect(state.cancelled).toBe(true);
    });

    it("reads a truncated body instead when asked", async () => {
        expect.assertions(2);

        const { response, state } = trackedResponse(400, "Bad Request", "x".repeat(HTTP_ERROR_BODY_MAX_CHARS + 50));
        const error = (await assertOk(response, "API", { includeBody: true }).catch((error_: unknown) => error_)) as HttpError;

        expect(error.body).toHaveLength(HTTP_ERROR_BODY_MAX_CHARS);
        expect(state.cancelled).toBe(false);
    });
});

describe(fetchOk, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("resolves with an OK response and forwards the deadline", async () => {
        expect.assertions(2);

        const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));

        vi.stubGlobal("fetch", fetchSpy);

        const response = await fetchOk("https://example.test", { errorPrefix: "X", method: "POST" });

        await expect(response.text()).resolves.toBe("ok");
        expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: "POST", signal: expect.any(AbortSignal) });
    });

    it("throws an HttpError on a non-OK response", async () => {
        expect.assertions(1);

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("nope", { status: 404, statusText: "Not Found" })),
        );

        await expect(fetchOk("https://example.test", { errorPrefix: "Lookup failed" })).rejects.toMatchObject({
            message: "Lookup failed: 404 Not Found",
            name: "HttpError",
            status: 404,
        });
    });
});
