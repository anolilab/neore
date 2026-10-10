import { describe, expect, it } from "vitest";

import { capUtf8, generateDeviceSecret, isDeviceSecret, isFreshTimestamp, parseSignedPayload, signDevicePayload, verifyDevicePayload } from "./signing";

/**
 * The same vectors are pinned on the Rust side (`apps/native/src-tauri/src/device/envelope.rs`),
 * so a change to the wire format on either side fails both suites.
 */
const SECRET = "0123456789abcdef".repeat(4);
const VECTORS = [
    { domain: "call", payload: '{"v":1,"kind":"call"}', signature: "1b5fba44e5ec8d6a71b4b7d5b471382b89ca9b147ab0cf28976e9e7756a73ef6" },
    { domain: "result", payload: '{"v":1,"kind":"result"}', signature: "daa229ed46e84f7169dea3c844bd5e85f69954c9c8dbf8e602d2e6bdee544925" },
    { domain: "manifest", payload: '{"v":1,"kind":"manifest"}', signature: "594692da0c9e03e5b885fcecd59e21c8f9cc61c2bf6ca11f75da1ace7da8687f" },
    { domain: "progress", payload: '{"v":1,"kind":"progress"}', signature: "11754e18ca1e841537e220af075d8908a42cb8bca86d8f0f133068e3a5d479c0" },
] as const;

describe("device signing", () => {
    it.each(VECTORS)("matches the shared $domain vector", async ({ domain, payload, signature }) => {
        await expect(signDevicePayload(SECRET, domain, payload)).resolves.toBe(signature);
        await expect(verifyDevicePayload(SECRET, domain, payload, signature)).resolves.toBe(true);
    });

    it("refuses a payload signed for another domain", async () => {
        const [call] = VECTORS;

        await expect(verifyDevicePayload(SECRET, "result", call.payload, call.signature)).resolves.toBe(false);
    });

    it("refuses an altered payload, another secret and a malformed signature", async () => {
        const [call] = VECTORS;

        await expect(verifyDevicePayload(SECRET, "call", `${call.payload} `, call.signature)).resolves.toBe(false);
        await expect(verifyDevicePayload("f".repeat(64), "call", call.payload, call.signature)).resolves.toBe(false);
        await expect(verifyDevicePayload(SECRET, "call", call.payload, "not-hex")).resolves.toBe(false);
    });

    it("generates 64-hex secrets", () => {
        const secret = generateDeviceSecret();

        expect(isDeviceSecret(secret)).toBe(true);
        expect(generateDeviceSecret()).not.toBe(secret);
    });
});

describe("parseSignedPayload", () => {
    it("accepts the expected kind and device only", () => {
        const payload = JSON.stringify({ deviceId: "d1", kind: "result", v: 1 });

        expect(parseSignedPayload(payload, "result", "d1")).toMatchObject({ deviceId: "d1" });
        expect(parseSignedPayload(payload, "manifest", "d1")).toBeNull();
        expect(parseSignedPayload(payload, "result", "d2")).toBeNull();
        expect(parseSignedPayload("[1]", "result", "d1")).toBeNull();
        expect(parseSignedPayload("{", "result", "d1")).toBeNull();
    });
});

describe("isFreshTimestamp", () => {
    it("allows skew either side within the window", () => {
        expect(isFreshTimestamp(1000, 1500, 600)).toBe(true);
        expect(isFreshTimestamp(2000, 1500, 600)).toBe(true);
        expect(isFreshTimestamp(100, 1500, 600)).toBe(false);
        expect(isFreshTimestamp("1500", 1500, 600)).toBe(false);
    });
});

describe("capUtf8", () => {
    it("leaves short text alone", () => {
        expect(capUtf8("hello", 10)).toEqual({ text: "hello", truncated: false });
    });

    it("never splits a multi-byte character", () => {
        // "é" is two bytes: a 3-byte cap keeps one "é", not one and a half.
        expect(capUtf8("éé", 3)).toEqual({ text: "é", truncated: true });
        // "😀" is four bytes.
        expect(capUtf8("a😀", 4)).toEqual({ text: "a", truncated: true });
    });
});
