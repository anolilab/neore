import { describe, expect, it } from "vitest";

import { verifyHmacSignature } from "../triggers/http";
import {
    buildTestEvent,
    generateRunWebhookSecret,
    MAX_RUN_WEBHOOK_URL_LENGTH,
    RUN_WEBHOOK_SECRET_PREFIX,
    RUN_WEBHOOK_TEST_EVENT,
    runWebhookUrlProblem,
    signRunWebhook,
} from "./payload";

const SECRET_FORMAT = /^whsec_[\w-]{43}$/u;
const SIGNATURE_FORMAT = /^sha256=[\da-f]{64}$/u;
const EVENT_ID_FORMAT = /^[\da-f-]{36}$/u;

describe("generateRunWebhookSecret", () => {
    it("is prefixed, URL-safe and different on every call", () => {
        const first = generateRunWebhookSecret();
        const second = generateRunWebhookSecret();

        expect(first.startsWith(RUN_WEBHOOK_SECRET_PREFIX)).toBe(true);
        expect(first).toMatch(SECRET_FORMAT);
        expect(first).not.toBe(second);
    });
});

describe("signRunWebhook", () => {
    const secret = "whsec_test-secret";
    const body = JSON.stringify({ type: RUN_WEBHOOK_TEST_EVENT });

    it('signs "<timestamp>.<body>" in the inbound trigger scheme, so the trigger verifier accepts it', async () => {
        const headers = await signRunWebhook(secret, body, 1_800_000_000);

        expect(headers["X-Neore-Timestamp"]).toBe("1800000000");
        expect(headers["X-Signature-256"]).toMatch(SIGNATURE_FORMAT);
        expect(await verifyHmacSignature(secret, `1800000000.${body}`, headers["X-Signature-256"]!)).toBe(true);
    });

    it("does not verify for another body, timestamp or secret", async () => {
        const headers = await signRunWebhook(secret, body, 1_800_000_000);
        const signature = headers["X-Signature-256"]!;

        expect(await verifyHmacSignature(secret, `1800000000.${body} `, signature)).toBe(false);
        expect(await verifyHmacSignature(secret, `1800000001.${body}`, signature)).toBe(false);
        expect(await verifyHmacSignature("whsec_other", `1800000000.${body}`, signature)).toBe(false);
    });
});

describe("runWebhookUrlProblem", () => {
    it("accepts a public https URL", () => {
        expect(runWebhookUrlProblem("https://example.com/hooks/neore")).toBeNull();
    });

    it.each([
        // The refusal needs a plain http URL, so this one literal is allowed to be http.
        // eslint-disable-next-line unicorn/prefer-https
        ["plain http", "http://example.com/hook"],
        ["loopback name", "https://localhost/hook"],
        ["loopback address", "https://127.0.0.1/hook"],
        ["private range", "https://10.0.0.5/hook"],
        ["cloud metadata address", "https://169.254.169.254/latest"],
        ["IPv6 loopback", "https://[::1]/hook"],
        ["a username in the URL", "https://reviewer@example.com/hook"],
        ["not a URL", "example.com/hook"],
        ["a file URL", "file:///etc/passwd"],
    ])("refuses %s", (_label, url) => {
        expect(runWebhookUrlProblem(url)).not.toBeNull();
    });

    it("refuses a URL over the length cap", () => {
        const url = `https://example.com/${"a".repeat(MAX_RUN_WEBHOOK_URL_LENGTH)}`;

        expect(runWebhookUrlProblem(url)).toBe("The URL is too long.");
    });
});

describe("buildTestEvent", () => {
    it("names no run and carries only the test message", () => {
        const event = buildTestEvent(1_800_000_000_000);

        expect(event.type).toBe(RUN_WEBHOOK_TEST_EVENT);
        expect(event.createdAt).toBe(1_800_000_000_000);
        expect(event.data).toEqual({ message: "This is a test delivery from Neore." });
        expect(event.id).toMatch(EVENT_ID_FORMAT);
    });
});
