/**
 * The one set of signing primitives every verifier in the backend uses.
 */
import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64, bytesToHex, hmacSha256Hex, isWithinWindow, secretsMatch, sha256Hex, timingSafeEqual } from "./crypto";

const TOKEN = "a-long-admin-token-value";

describe("timingSafeEqual", () => {
    it("matches only identical strings", () => {
        expect(timingSafeEqual("abc", "abc")).toBe(true);
        expect(timingSafeEqual("abc", "abd")).toBe(false);
        expect(timingSafeEqual("abc", "abcd")).toBe(false);
        expect(timingSafeEqual("", "")).toBe(true);
    });
});

describe("secretsMatch", () => {
    it("matches only the identical secret, including across lengths", async () => {
        await expect(secretsMatch(TOKEN, TOKEN)).resolves.toBe(true);
        await expect(secretsMatch(`${TOKEN}x`, TOKEN)).resolves.toBe(false);
        await expect(secretsMatch(TOKEN.slice(0, -1), TOKEN)).resolves.toBe(false);
        await expect(secretsMatch("", TOKEN)).resolves.toBe(false);
    });
});

describe("digests", () => {
    it("produce the standard test vectors", async () => {
        // RFC 4231 test case 2.
        await expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).resolves.toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        await expect(sha256Hex("abc")).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        await expect(hmacSha256Hex(new TextEncoder().encode("Jefe"), new TextEncoder().encode("what do ya want for nothing?"))).resolves.toBe(
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
        );
    });

    it("round-trips base64 and hex", () => {
        const bytes = new Uint8Array([0, 15, 255]);

        expect(bytesToHex(bytes)).toBe("000fff");
        expect(base64ToBytes(bytesToBase64(bytes))).toStrictEqual(bytes);
    });
});

describe("isWithinWindow", () => {
    it("accepts either direction inside the window and never a non-finite timestamp", () => {
        expect(isWithinWindow(1000, 500, 1400)).toBe(true);
        expect(isWithinWindow(1900, 500, 1400)).toBe(true);
        expect(isWithinWindow(800, 500, 1400)).toBe(false);
        expect(isWithinWindow(NaN, 500, 1400)).toBe(false);
    });
});
