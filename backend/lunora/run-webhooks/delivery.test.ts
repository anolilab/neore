import { describe, expect, it, vi } from "vitest";

import { buildTestEvent } from "./payload";
import { deliverRunWebhook } from "./delivery";

const NOW = 1_800_000_000_000;
const SECRET = "whsec_test-secret";
const URL_OK = "https://example.com/hooks/neore";
const SIGNATURE_FORMAT = /^sha256=[\da-f]{64}$/u;

// A 204 cannot carry a body, so the helper sends none for it.
const reply = (status: number): Response => new Response(status === 204 ? null : "secret receiver body", { status });

describe("deliverRunWebhook", () => {
    it("POSTs the signed event with redirects off, and reports only the status", async () => {
        const send = vi.fn(async () => reply(204));
        const event = buildTestEvent(NOW);

        const result = await deliverRunWebhook({ event, now: NOW, secret: SECRET, send, url: URL_OK });

        expect(result).toEqual({ durationMs: expect.any(Number), ok: true, status: 204 });
        expect(send).toHaveBeenCalledTimes(1);

        const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
        const headers = init.headers as Record<string, string>;

        expect(url).toBe(URL_OK);
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("manual");
        expect(init.body).toBe(JSON.stringify(event));
        expect(headers["x-neore-event"]).toBe("webhook.test");
        expect(headers["x-neore-event-id"]).toBe(event.id);
        expect(headers["X-Neore-Timestamp"]).toBe(String(Math.floor(NOW / 1000)));
        expect(headers["X-Signature-256"]).toMatch(SIGNATURE_FORMAT);
    });

    it("never puts the secret or the receiver's answer into the result", async () => {
        const result = await deliverRunWebhook({ event: buildTestEvent(NOW), now: NOW, secret: SECRET, send: async () => reply(200), url: URL_OK });

        expect(JSON.stringify(result)).not.toContain(SECRET);
        expect(JSON.stringify(result)).not.toContain("secret receiver body");
    });

    it("counts a redirect as a failed delivery, since redirects are not followed", async () => {
        const result = await deliverRunWebhook({
            event: buildTestEvent(NOW),
            now: NOW,
            secret: SECRET,
            send: async () => new Response(null, { headers: { location: "https://elsewhere.example/" }, status: 302 }),
            url: URL_OK,
        });

        expect(result).toMatchObject({ ok: false, status: 302 });
    });

    it("counts a 5xx answer as a failed delivery", async () => {
        const result = await deliverRunWebhook({ event: buildTestEvent(NOW), now: NOW, secret: SECRET, send: async () => reply(503), url: URL_OK });

        expect(result).toMatchObject({ ok: false, status: 503 });
    });

    it("refuses a private target before any request is made", async () => {
        const send = vi.fn(async () => reply(200));

        const result = await deliverRunWebhook({
            event: buildTestEvent(NOW),
            now: NOW,
            secret: SECRET,
            send,
            url: "https://169.254.169.254/latest/meta-data",
        });

        expect(send).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: false });
        expect(result.error).toContain("private");
    });

    it("reports a timeout in plain words", async () => {
        const result = await deliverRunWebhook({
            event: buildTestEvent(NOW),
            now: NOW,
            secret: SECRET,
            send: async () => {
                throw new Error("Request timeout after 10000ms");
            },
            url: URL_OK,
        });

        expect(result).toMatchObject({ error: "The receiver did not answer within 10 seconds.", ok: false });
    });

    it("reports other transport failures by error name only", async () => {
        const result = await deliverRunWebhook({
            event: buildTestEvent(NOW),
            now: NOW,
            secret: SECRET,
            send: async () => {
                throw new TypeError("fetch failed for https://example.com/hooks/neore?token=x");
            },
            url: URL_OK,
        });

        expect(result).toMatchObject({ error: "The request failed (TypeError).", ok: false });
        expect(result.error).not.toContain("token=x");
    });
});
