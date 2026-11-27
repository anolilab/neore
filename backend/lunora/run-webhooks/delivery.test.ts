import { describe, expect, it, vi } from "vitest";

import { EgressError } from "../lib/egress";
import { buildTestEvent } from "./payload";
import { type RunWebhookSend, deliverRunWebhook } from "./delivery";

const NOW = 1_800_000_000_000;
const SECRET = "whsec_test-secret";
const URL_OK = "https://example.com/hooks/neore";
const SIGNATURE_FORMAT = /^sha256=[\da-f]{64}$/u;

describe("deliverRunWebhook", () => {
    it("hands the signed event to the checked HTTPS helper, and reports only the status", async () => {
        const send = vi.fn<RunWebhookSend>(async () => {
            return { status: 204 };
        });
        const event = buildTestEvent(NOW);

        const result = await deliverRunWebhook({ event, now: NOW, secret: SECRET, send, url: URL_OK });

        expect(result).toEqual({ durationMs: expect.any(Number), ok: true, status: 204 });
        expect(send).toHaveBeenCalledTimes(1);

        const request = send.mock.calls[0]?.[0];

        expect(request).toMatchObject({ body: JSON.stringify(event), timeoutMs: 10_000, url: URL_OK });
        expect(request?.headers["x-neore-event"]).toBe("webhook.test");
        expect(request?.headers["x-neore-event-id"]).toBe(event.id);
        expect(request?.headers["X-Neore-Timestamp"]).toBe(String(Math.floor(NOW / 1000)));
        expect(request?.headers["X-Signature-256"]).toMatch(SIGNATURE_FORMAT);
    });

    it("never puts the secret into the result", async () => {
        const result = await deliverRunWebhook({
            event: buildTestEvent(NOW),
            now: NOW,
            secret: SECRET,
            send: async () => {
                return { status: 200 };
            },
            url: URL_OK,
        });

        expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it("counts a redirect as a failed delivery, since redirects are not followed", async () => {
        const result = await deliverRunWebhook({
            event: buildTestEvent(NOW),
            now: NOW,
            secret: SECRET,
            send: async () => {
                return { status: 302 };
            },
            url: URL_OK,
        });

        expect(result).toMatchObject({ ok: false, status: 302 });
    });

    it("counts a 5xx answer as a failed delivery", async () => {
        const result = await deliverRunWebhook({
            event: buildTestEvent(NOW),
            now: NOW,
            secret: SECRET,
            send: async () => {
                return { status: 503 };
            },
            url: URL_OK,
        });

        expect(result).toMatchObject({ ok: false, status: 503 });
    });

    it("refuses a literal private target before any request is made", async () => {
        const send = vi.fn<RunWebhookSend>(async () => {
            return { status: 200 };
        });

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
                throw new EgressError("timeout", "The request ran past its deadline.");
            },
            url: URL_OK,
        });

        expect(result).toMatchObject({ error: "The receiver did not answer within 10 seconds.", ok: false });
    });

    it("maps a refused address to fixed words, never the host or the error text", async () => {
        const result = await deliverRunWebhook({
            event: buildTestEvent(NOW),
            now: NOW,
            secret: SECRET,
            send: async () => {
                throw new EgressError("blocked_address", "hooks.example.com resolved to a non-public address");
            },
            url: URL_OK,
        });

        expect(result).toMatchObject({ error: expect.stringContaining("private"), ok: false });
        expect(result.error).not.toContain("hooks.example.com");
    });

    it("explains a Cloudflare-hosted receiver instead of a generic failure", async () => {
        const result = await deliverRunWebhook({
            event: buildTestEvent(NOW),
            now: NOW,
            secret: SECRET,
            send: async () => {
                throw new EgressError("unsupported_target", "hooks.example.com is served by Cloudflare");
            },
            url: URL_OK,
        });

        expect(result).toMatchObject({ error: expect.stringContaining("Cloudflare"), ok: false });
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
