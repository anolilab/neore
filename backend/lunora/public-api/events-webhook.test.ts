/**
 * The webhook request rules of `events/subscribe` and `events/unsubscribe`: the `whsec_` secret, the callback URL, the host
 * names the allowlist stores, the TTL grant, the subscription key and its id. Pure: no store, no network.
 */
import { describe, expect, it } from "vitest";

/* eslint-disable sonarjs/no-hardcoded-ip -- test data: literal addresses the rules must refuse, none of them dialled */
import { bytesToBase64 } from "../lib/crypto";
import {
    argumentsKeyOf,
    DEFAULT_TTL_MS,
    grantTtlMs,
    isWebhookSecret,
    MAX_TTL_MS,
    MIN_TTL_MS,
    normalizeApprovedHost,
    parseSubscribeParams,
    parseUnsubscribeParams,
    subscriptionIdOf,
    subscriptionKeyHash,
    webhookSecretBytes,
} from "./events-webhook";

const secretOf = (bytes: number): string => `whsec_${bytesToBase64(new Uint8Array(bytes).fill(9))}`;
const VALID_URL = "https://hooks.example.com/neore";
const ID_SHAPE = /^sub_[\da-f]{16}$/;

const subscribeWith = (overrides: Record<string, unknown> = {}, delivery: Record<string, unknown> = {}) => {
    return {
        delivery: { mode: "webhook", secret: secretOf(24), url: VALID_URL, ...delivery },
        name: "run.completed",
        ...overrides,
    };
};

describe("the whsec_ secret", () => {
    it("accepts whsec_ and the base64 of 24 to 64 bytes, and nothing else", () => {
        expect(isWebhookSecret(secretOf(24))).toBe(true);
        expect(isWebhookSecret(secretOf(64))).toBe(true);
        expect(isWebhookSecret(secretOf(23))).toBe(false);
        expect(isWebhookSecret(secretOf(65))).toBe(false);
        expect(isWebhookSecret(bytesToBase64(new Uint8Array(24)))).toBe(false);
        expect(isWebhookSecret(`${secretOf(24)} `)).toBe(false);
        // 0xfb bytes encode to a "+": the URL-safe alphabet is not the Standard Webhooks one.
        expect(isWebhookSecret(`whsec_${bytesToBase64(new Uint8Array(24).fill(0xfb))}`.replace("+", "-"))).toBe(false);
        expect(isWebhookSecret(42)).toBe(false);
    });

    it("decodes to the raw bytes the signature is keyed with", () => {
        expect(webhookSecretBytes(secretOf(24))).toStrictEqual(new Uint8Array(24).fill(9));
    });
});

describe("the approved host", () => {
    it("is a lowercase host name, and nothing that is an address or a single label", () => {
        expect(normalizeApprovedHost("Hooks.Example.COM")).toBe("hooks.example.com");
        expect(normalizeApprovedHost("  hooks.example.com ")).toBe("hooks.example.com");
        expect(normalizeApprovedHost("localhost")).toBeNull();
        expect(normalizeApprovedHost("10.0.0.1")).toBeNull();
        expect(normalizeApprovedHost("[::1]")).toBeNull();
        expect(normalizeApprovedHost("https://hooks.example.com")).toBeNull();
        expect(normalizeApprovedHost("hooks.example.com:443")).toBeNull();
        expect(normalizeApprovedHost("a..example.com")).toBeNull();
        expect(normalizeApprovedHost("")).toBeNull();
    });
});

describe("the TTL grant", () => {
    it("uses the default when omitted, the cap for no expiry, and clamps a suggestion into [min, max]", () => {
        expect(grantTtlMs(undefined)).toBe(DEFAULT_TTL_MS);
        expect(grantTtlMs(null)).toBe(MAX_TTL_MS);
        expect(grantTtlMs(1000)).toBe(MIN_TTL_MS);
        expect(grantTtlMs(MAX_TTL_MS * 4)).toBe(MAX_TTL_MS);
        expect(grantTtlMs(120_000)).toBe(120_000);
    });
});

describe("events/subscribe params", () => {
    it("reads a valid request: the host, the href, no arguments, the default TTL, no cursor", () => {
        const parsed = parseSubscribeParams(subscribeWith());

        expect(parsed).toStrictEqual({
            ok: true,
            value: {
                argumentsKey: "{}",
                cursor: null,
                grantedTtlMs: DEFAULT_TTL_MS,
                host: "hooks.example.com",
                maxAgeMs: null,
                name: "run.completed",
                secret: secretOf(24),
                url: VALID_URL,
            },
        });
    });

    it("keys a threadId argument as canonical text", () => {
        const parsed = parseSubscribeParams(subscribeWith({ arguments: { threadId: "t1" } }));

        expect(parsed.ok && parsed.value.argumentsKey).toBe('{"threadId":"t1"}');
    });

    it("answers an unknown event with NotFound, its kind in the data", () => {
        expect(parseSubscribeParams(subscribeWith({ name: "nope" }))).toMatchObject({ code: -32_023, data: { kind: "event" }, ok: false });
    });

    it("answers a bad secret, a missing or non-webhook mode, and an arguments mismatch with InvalidParams", () => {
        expect(parseSubscribeParams(subscribeWith({}, { secret: "whsec_nope" }))).toMatchObject({ code: -32_602, ok: false });
        expect(parseSubscribeParams(subscribeWith({}, { mode: undefined }))).toMatchObject({ code: -32_602, ok: false });
        expect(parseSubscribeParams(subscribeWith({ arguments: { severity: "P1" } }))).toMatchObject({ code: -32_602, ok: false });
    });

    it("answers another delivery mode with Unsupported, naming it", () => {
        expect(parseSubscribeParams(subscribeWith({}, { mode: "push" }))).toMatchObject({
            code: -32_026,
            data: { feature: "deliveryMode", value: "push" },
            ok: false,
        });
    });

    it("refuses a callback that is not a plain https host on the default port", () => {
        for (const url of [
            // eslint-disable-next-line unicorn/prefer-https -- a plain-http callback is the case under test
            "http://hooks.example.com/x",
            "https://hooks.example.com:8443/x",
            "https://user:pw@hooks.example.com/x",
            "https://10.0.0.1/x",
            "https://[::1]/x",
            "https://localhost/x",
            "not a url",
        ]) {
            expect(parseSubscribeParams(subscribeWith({}, { url }))).toMatchObject({ code: -32_602, ok: false });
        }
    });

    it("grants the suggested TTL within the bounds, and no expiry as the cap", () => {
        expect(parseSubscribeParams(subscribeWith({ ttlMs: null }))).toMatchObject({ ok: true, value: { grantedTtlMs: MAX_TTL_MS } });
        expect(parseSubscribeParams(subscribeWith({ ttlMs: 5000 }))).toMatchObject({ ok: true, value: { grantedTtlMs: MIN_TTL_MS } });
        expect(parseSubscribeParams(subscribeWith({ ttlMs: "soon" }))).toMatchObject({ code: -32_602, ok: false });
        expect(parseSubscribeParams(subscribeWith({ ttlMs: -1 }))).toMatchObject({ code: -32_602, ok: false });
    });

    it("rejects a non-string cursor and a negative maxAgeMs", () => {
        expect(parseSubscribeParams(subscribeWith({ cursor: 3 }))).toMatchObject({ code: -32_602, ok: false });
        expect(parseSubscribeParams(subscribeWith({ maxAgeMs: -1 }))).toMatchObject({ code: -32_602, ok: false });
    });
});

describe("events/unsubscribe params", () => {
    it("reads the same key without a secret or a TTL", () => {
        expect(parseUnsubscribeParams({ delivery: { url: VALID_URL }, name: "run.completed" })).toStrictEqual({
            ok: true,
            value: { argumentsKey: "{}", name: "run.completed", url: VALID_URL },
        });
    });

    it("answers an unknown event with NotFound and another mode with Unsupported", () => {
        expect(parseUnsubscribeParams({ delivery: { url: VALID_URL }, name: "nope" })).toMatchObject({ code: -32_023, ok: false });
        expect(parseUnsubscribeParams({ delivery: { mode: "push", url: VALID_URL }, name: "run.completed" })).toMatchObject({ code: -32_026, ok: false });
    });
});

describe("the subscription key", () => {
    it("is stable for one (principal, url, name, arguments) and differs when any of them does", async () => {
        const base = await subscriptionKeyHash("key-1", VALID_URL, "run.completed", "{}");

        expect(await subscriptionKeyHash("key-1", VALID_URL, "run.completed", "{}")).toBe(base);
        expect(await subscriptionKeyHash("key-2", VALID_URL, "run.completed", "{}")).not.toBe(base);
        expect(await subscriptionKeyHash("key-1", `${VALID_URL}/other`, "run.completed", "{}")).not.toBe(base);
        expect(await subscriptionKeyHash("key-1", VALID_URL, "run.failed", "{}")).not.toBe(base);
        expect(await subscriptionKeyHash("key-1", VALID_URL, "run.completed", '{"threadId":"t1"}')).not.toBe(base);
    });

    it("derives a routing id of sub_ and 16 hex characters, from the key", async () => {
        const id = subscriptionIdOf(await subscriptionKeyHash("key-1", VALID_URL, "run.completed", "{}"));

        expect(id).toMatch(ID_SHAPE);
    });

    it("keys no arguments as {} and a threadId as its canonical JSON", () => {
        expect(argumentsKeyOf({})).toBe("{}");
        expect(argumentsKeyOf({ threadId: "t1" })).toBe('{"threadId":"t1"}');
    });
});
