import { describe, expect, it, vi } from "vitest";

const ALL_ASTERISKS_RE = /^\*+$/;
const V1_PREFIX_RE = /^v1:/;
// Set ENCRYPTION_KEY before the module loads (top-level check requires it)
// Generate a valid 32-byte base64 key
const testKeyBytes = new Uint8Array(32);

crypto.getRandomValues(testKeyBytes);
vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...testKeyBytes)));

const { decryptKey, encryptKey, maskKey } = await import("./encryption");

describe("maskKey", () => {
    it("should fully mask short keys (8 chars or less)", () => {
        expect(maskKey("abc")).toBe("***");
        expect(maskKey("12345678")).toBe("********");
        expect(maskKey("")).toBe("");
        expect(maskKey("a")).toBe("*");
    });

    it("should show first 4 and last 4 chars for longer keys", () => {
        expect(maskKey("sk-123456789abc")).toBe("sk-1*******9abc");
        expect(maskKey("123456789")).toBe("1234*6789");
        expect(maskKey("abcdefghij")).toBe("abcd**ghij");
    });

    it("should mask the middle with correct number of asterisks", () => {
        const key = "sk-proj-abcdefghijklmnop";
        const masked = maskKey(key);

        // First 4 chars
        expect(masked.slice(0, 4)).toBe("sk-p");
        // Last 4 chars
        expect(masked.slice(-4)).toBe("mnop");
        // Middle should be asterisks of correct length
        expect(masked).toHaveLength(key.length);
        expect(masked.slice(4, -4)).toMatch(ALL_ASTERISKS_RE);
    });
});

describe("encryptKey/decryptKey roundtrip", () => {
    it("should encrypt and decrypt back to the original value", async () => {
        const plaintext = "sk-test-secret-api-key-12345";
        const encrypted = await encryptKey(plaintext);
        const decrypted = await decryptKey(encrypted);

        expect(decrypted).toBe(plaintext);
    });

    it("should produce different ciphertexts for the same plaintext (random IV)", async () => {
        const plaintext = "same-input-different-output";
        const encrypted1 = await encryptKey(plaintext);
        const encrypted2 = await encryptKey(plaintext);

        expect(encrypted1).not.toBe(encrypted2);
    });

    it("should handle empty strings", async () => {
        const encrypted = await encryptKey("");
        const decrypted = await decryptKey(encrypted);

        expect(decrypted).toBe("");
    });

    it("should handle unicode strings", async () => {
        const plaintext = "日本語テスト 🔐";
        const encrypted = await encryptKey(plaintext);
        const decrypted = await decryptKey(encrypted);

        expect(decrypted).toBe(plaintext);
    });

    it("should return a versioned ciphertext string", async () => {
        const encrypted = await encryptKey("test");

        // v1 format: "v1:<base64>"
        expect(encrypted).toMatch(V1_PREFIX_RE);
        // The base64 part should be valid
        expect(() => atob(encrypted.slice(3))).not.toThrow();
    });
});

describe("HKDF per-purpose key derivation", () => {
    it("should encrypt/decrypt with different purposes independently", async () => {
        const plaintext = "cross-purpose-test";
        const encrypted = await encryptKey(plaintext, "provider-keys");
        const decrypted = await decryptKey(encrypted, "provider-keys");

        expect(decrypted).toBe(plaintext);
    });

    it("should fail to decrypt with wrong purpose", async () => {
        const plaintext = "wrong-purpose-test";
        const encrypted = await encryptKey(plaintext, "provider-keys");

        // Decrypting with a different purpose should fail
        await expect(decryptKey(encrypted, "messenger-keys")).rejects.toThrow();
    });

    it("should support all key purposes", async () => {
        const purposes = ["provider-keys", "tool-keys", "messenger-keys", "custom-providers"] as const;

        for (const purpose of purposes) {
            const plaintext = `test-${purpose}`;
            const encrypted = await encryptKey(plaintext, purpose);
            const decrypted = await decryptKey(encrypted, purpose);

            expect(decrypted).toBe(plaintext);
        }
    });
});

describe("backward compatibility (v0 legacy)", () => {
    it("should decrypt legacy unversioned ciphertext", async () => {
        // Simulate v0 encryption: raw master key, no version prefix
        const plaintext = "legacy-secret";
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await crypto.subtle.importKey("raw", testKeyBytes.slice(0, 32), { length: 256, name: "AES-GCM" }, false, ["encrypt"]);
        const encryptedBuffer = await crypto.subtle.encrypt({ iv, name: "AES-GCM" }, key, new TextEncoder().encode(plaintext));
        const encryptedArray = new Uint8Array(encryptedBuffer);
        const combined = new Uint8Array(iv.length + encryptedArray.length);

        combined.set(iv, 0);
        combined.set(encryptedArray, iv.length);
        const legacyCiphertext = btoa(String.fromCodePoint(...combined));

        // decryptKey should handle unversioned (v0) ciphertext
        const decrypted = await decryptKey(legacyCiphertext);

        expect(decrypted).toBe(plaintext);
    });
});
