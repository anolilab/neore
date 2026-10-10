import type { ObservabilityEvent } from "lunorash/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { posthogErrorSink } from "./posthog-sink";

const ENV = { ENVIRONMENT: "production", POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "https://eu.i.posthog.com/" };

const rpc = (error: ObservabilityEvent["error"]): ObservabilityEvent => {
    return { durationMs: 5, error, functionPath: "chat:send", ok: false };
};

describe(posthogErrorSink, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("is off without an API key", () => {
        expect(posthogErrorSink({})).toBeUndefined();
    });

    it("reports a 5xx RPC and a logged error, and ignores a 4xx and a log line without one", () => {
        const fetchMock = vi.fn(async () => new Response(null));

        vi.stubGlobal("fetch", fetchMock);

        const sink = posthogErrorSink(ENV);
        const waitUntil = vi.fn();

        sink?.onRpc?.(rpc({ code: "BAD_REQUEST", message: "nope", status: 400 }), { waitUntil });
        sink?.onRpc?.(rpc({ code: "INTERNAL", message: "boom", status: 500 }), { waitUntil });
        sink?.onLog?.({ args: [], functionPath: "chat:send", level: "info", message: "fine", ts: 0 }, { waitUntil });
        sink?.onLog?.(
            {
                args: [],
                error: { message: "broke", name: "TypeError", stack: "TypeError: broke\n    at run (chat.ts:1:2)" },
                functionPath: "chat:send",
                level: "error",
                message: "broke",
                ts: 0,
                userId: "u1",
            },
            { waitUntil },
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(waitUntil).toHaveBeenCalledTimes(2);

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        const body = JSON.parse(String(init.body)) as {
            distinct_id: string;
            event: string;
            properties: { $exception_list: { type: string; value: string }[] };
        };

        expect(url).toBe("https://eu.i.posthog.com/i/v0/e/");
        expect(body.event).toBe("$exception");
        expect(body.properties.$exception_list[0]).toMatchObject({ type: "INTERNAL", value: "boom" });
        expect((JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)) as { distinct_id: string }).distinct_id).toBe("u1");
    });
});
