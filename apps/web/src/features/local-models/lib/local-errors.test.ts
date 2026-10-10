import { describe, expect, it, vi } from "vitest";

import { classifyLocalError, isSafariUserAgent, LocalHttpError, probeReachableWithoutCors } from "./local-errors";
import { LocalStreamError } from "./openai-sse";

const LOOPBACK = ["http", "//localhost:11434/v1"].join(":");
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";
const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0";

const networkError = () => new TypeError("Failed to fetch");
/** What browsers throw for `AbortSignal.timeout()` and `controller.abort()`. */
const named = (name: string) => new DOMException(name, name);

describe(classifyLocalError, () => {
    const base = { endpointUrl: LOOPBACK, pageProtocol: "https:", userAgent: CHROME };

    it("tells a CORS rejection from a refused connection with the no-cors probe", () => {
        expect.assertions(2);
        expect(classifyLocalError(networkError(), { ...base, reachableWithoutCors: true }).kind).toBe("cors");
        expect(classifyLocalError(networkError(), { ...base, reachableWithoutCors: false }).kind).toBe("unreachable");
    });

    it("reads an unprobed network error as unreachable", () => {
        expect.assertions(1);
        expect(classifyLocalError(networkError(), base).kind).toBe("unreachable");
    });

    it("blames Safari's mixed-content rule for http loopback from an https page", () => {
        expect.assertions(3);
        expect(classifyLocalError(networkError(), { ...base, reachableWithoutCors: false, userAgent: SAFARI }).kind).toBe("mixed-content");
        // Chromium and Firefox treat localhost as a secure context: not mixed content.
        expect(classifyLocalError(networkError(), { ...base, userAgent: FIREFOX }).kind).toBe("unreachable");
        // An http app page (local dev) is never mixed content.
        expect(classifyLocalError(networkError(), { ...base, pageProtocol: "http:", userAgent: SAFARI }).kind).toBe("unreachable");
    });

    it("reports a denied Local Network Access permission before guessing at CORS", () => {
        expect.assertions(1);
        expect(classifyLocalError(networkError(), { ...base, localNetworkPermission: "denied", reachableWithoutCors: false }).kind).toBe("permission-denied");
    });

    it("separates timeouts and user aborts", () => {
        expect.assertions(2);
        expect(classifyLocalError(named("TimeoutError"), base).kind).toBe("timeout");
        expect(classifyLocalError(named("AbortError"), base).kind).toBe("aborted");
    });

    it("maps HTTP answers, with 404 as a missing model", () => {
        expect.assertions(2);
        expect(classifyLocalError(new LocalHttpError(404, 'model "qwen3:8b" not found, try pulling it first'), base)).toStrictEqual({
            detail: 'model "qwen3:8b" not found, try pulling it first',
            kind: "not-found",
            status: 404,
        });
        expect(classifyLocalError(new LocalHttpError(500, undefined), base)).toMatchObject({ kind: "http", status: 500 });
    });

    it("keeps a stream error's own message", () => {
        expect.assertions(1);
        expect(classifyLocalError(new LocalStreamError("out of memory"), base)).toStrictEqual({ detail: "out of memory", kind: "stream" });
    });
});

describe(isSafariUserAgent, () => {
    it("matches desktop Safari only", () => {
        expect.assertions(4);
        expect(isSafariUserAgent(SAFARI)).toBe(true);
        expect(isSafariUserAgent(CHROME)).toBe(false);
        expect(isSafariUserAgent(FIREFOX)).toBe(false);
        expect(isSafariUserAgent(undefined)).toBe(false);
    });
});

describe(probeReachableWithoutCors, () => {
    it("is true when anything answers and false when the connection fails", async () => {
        expect.assertions(3);

        const answering = vi.fn(async () => new Response(null, { status: 200 }));

        await expect(probeReachableWithoutCors(LOOPBACK, answering as never)).resolves.toBe(true);
        expect(answering).toHaveBeenCalledWith("http://localhost:11434", expect.objectContaining({ mode: "no-cors" }));
        await expect(
            probeReachableWithoutCors(LOOPBACK, (async () => {
                throw networkError();
            }) as never),
        ).resolves.toBe(false);
    });
});
