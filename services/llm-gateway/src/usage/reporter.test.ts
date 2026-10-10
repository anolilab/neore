import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../env.js";
import { UsageReporter } from "./reporter";

const report = { completionTokens: 1, costMicrodollars: 10, modelId: "m", promptTokens: 1, requestId: "req-1", userId: "u" };
const env = { LUNORA_URL: "https://backend.test", SIGNING_SECRET: "s" } as AppEnv;

const responseWithTrackedBody = (status: number) => {
    const cancel = vi.fn();

    return { cancel, response: new Response(new ReadableStream({ cancel }), { status }) };
};

const makeReporter = (maxAttempts = 3) => {
    const sleep = vi.fn(async () => undefined);

    return { reporter: new UsageReporter(env, { baseDelayMs: 100, maxAttempts, sleep }), sleep };
};

describe(UsageReporter, () => {
    beforeEach(() => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("sends once on success, with the requestId as idempotency key, and cancels the body", async () => {
        const { cancel, response } = responseWithTrackedBody(200);
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => response);

        vi.stubGlobal("fetch", fetchMock);

        const { reporter, sleep } = makeReporter();

        await reporter.report(report);

        expect(fetchMock).toHaveBeenCalledOnce();
        expect((fetchMock.mock.calls[0]![1].headers as Record<string, string>)["Idempotency-Key"]).toBe("req-1");
        expect(cancel).toHaveBeenCalledOnce();
        expect(sleep).not.toHaveBeenCalled();
    });

    it("retries a 5xx and a network error with backoff, then succeeds", async () => {
        const first = responseWithTrackedBody(503);
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(first.response)
            .mockRejectedValueOnce(new TypeError("fetch failed"))
            .mockResolvedValueOnce(new Response("ok", { status: 200 }));

        vi.stubGlobal("fetch", fetchMock);

        const { reporter, sleep } = makeReporter();

        await reporter.report(report);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(sleep.mock.calls).toStrictEqual([[100], [200]]);
        // The failed attempt's body is released too.
        expect(first.cancel).toHaveBeenCalledOnce();
        // Every attempt carries the same idempotency key and body.
        const keys = fetchMock.mock.calls.map(([, init]) => (init as RequestInit & { headers: Record<string, string> }).headers["Idempotency-Key"]);

        expect(keys).toStrictEqual(["req-1", "req-1", "req-1"]);
    });

    it("gives up after the max attempts without throwing", async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));

        vi.stubGlobal("fetch", fetchMock);

        const { reporter, sleep } = makeReporter(3);

        await expect(reporter.report(report)).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(3);
        // No sleep after the final attempt.
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(console.error).toHaveBeenLastCalledWith(expect.stringContaining("Gave up"));
    });

    it("does not retry a 4xx", async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));

        vi.stubGlobal("fetch", fetchMock);

        const { reporter } = makeReporter();

        await reporter.report(report);

        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("gives each attempt a deadline, so a hung backend is retried rather than awaited forever", async () => {
        const signals: AbortSignal[] = [];
        const fetchMock = vi.fn(
            async (_url: string, init: RequestInit) =>
                await new Promise<Response>((_resolve, reject) => {
                    const signal = init.signal as AbortSignal;

                    signals.push(signal);
                    signal.addEventListener("abort", () => {
                        reject(signal.reason);
                    });
                }),
        );

        vi.stubGlobal("fetch", fetchMock);

        const sleep = vi.fn(async () => undefined);

        await new UsageReporter(env, { baseDelayMs: 100, maxAttempts: 2, sleep, timeoutMs: 20 }).report(report);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(sleep).toHaveBeenCalledOnce();
    });

    it("does not call out without a backend URL", async () => {
        const fetchMock = vi.fn();

        vi.stubGlobal("fetch", fetchMock);

        await new UsageReporter({} as AppEnv).report(report);

        expect(fetchMock).not.toHaveBeenCalled();
    });
});
