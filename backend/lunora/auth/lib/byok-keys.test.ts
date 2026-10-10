import { describe, expect, it, vi } from "vitest";

import type { KeyEntryInput, StoredKeyEntry } from "./byok-keys";
import { mergeKeyEntries, redactKeyEntries, redactPreferences } from "./byok-keys";

// `encryption.ts` checks ENCRYPTION_KEY at module load, so stub it first.
const testKeyBytes = new Uint8Array(32);

crypto.getRandomValues(testKeyBytes);
vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...testKeyBytes)));

const { decryptKey, encryptKey } = await import("../../lib/encryption");

const encrypt = async (plaintext: string) => await encryptKey(plaintext, "provider-keys");

/** What the settings UI does: read the redacted view, spread it, add one entry. */
const clientSave = async (stored: Record<string, StoredKeyEntry> | undefined, name: string, key: string, now: number) => {
    const view = (redactKeyEntries(stored) ?? {}) as Record<string, KeyEntryInput>;

    return await mergeKeyEntries({ ...view, [name]: { enabled: true, key } }, stored, encrypt, { now, stampMetadata: true });
};

describe(mergeKeyEntries, () => {
    it("saving key B leaves key A decryptable to its original plaintext", async () => {
        expect.assertions(3);

        const afterA = await clientSave(undefined, "openrouter", "sk-or-v1-aaaaaaaaaaaaaaaa", 1);
        const afterB = await clientSave(afterA, "groq", "gsk_bbbbbbbbbbbbbbbb", 2);

        await expect(decryptKey(afterB.openrouter!.encryptedKey, "provider-keys")).resolves.toBe("sk-or-v1-aaaaaaaaaaaaaaaa");
        await expect(decryptKey(afterB.groq!.encryptedKey, "provider-keys")).resolves.toBe("gsk_bbbbbbbbbbbbbbbb");
        // Untouched entry keeps its ciphertext and metadata byte-for-byte.
        expect(afterB.openrouter).toStrictEqual(afterA.openrouter);
    });

    it("ignores ciphertext echoed back in encryptedKey", async () => {
        expect.assertions(2);

        const stored = await clientSave(undefined, "xai", "xai-cccccccccccccccc", 1);
        const echoed = await mergeKeyEntries({ xai: { enabled: true, encryptedKey: "v1:attacker-or-stale" } }, stored, encrypt, {
            now: 2,
            stampMetadata: true,
        });

        expect(echoed.xai!.encryptedKey).toBe(stored.xai!.encryptedKey);
        await expect(decryptKey(echoed.xai!.encryptedKey, "provider-keys")).resolves.toBe("xai-cccccccccccccccc");
    });

    it("clears with an empty key and drops entries missing from input", async () => {
        expect.assertions(2);

        const stored = await clientSave(await clientSave(undefined, "a", "key-aaaaaaaaaaaa", 1), "b", "key-bbbbbbbbbbbb", 2);
        const merged = await mergeKeyEntries({ a: { enabled: false, key: "" } }, stored, encrypt, { now: 3, stampMetadata: true });

        expect(merged.a).toStrictEqual({ enabled: false, encryptedKey: "" });
        expect(merged).not.toHaveProperty("b");
    });

    it("keeps non-key fields and never takes server fields from input", async () => {
        expect.assertions(2);

        const merged = await mergeKeyEntries(
            { brave: { country: "DE", createdAt: 999, enabled: true, key: "BSA-dddddddddddd", last4: "hack" } },
            undefined,
            encrypt,
            { now: 5, stampMetadata: false },
        );

        expect(merged.brave).toMatchObject({ country: "DE", enabled: true, last4: "dddd" });
        expect(merged.brave).not.toHaveProperty("createdAt");
    });

    it("does not reveal the tail of a short key", async () => {
        expect.assertions(1);

        const merged = await mergeKeyEntries({ s: { enabled: true, key: "short" } }, undefined, encrypt, { now: 1, stampMetadata: true });

        expect(merged.s).not.toHaveProperty("last4");
    });
});

describe(redactPreferences, () => {
    it("removes every ciphertext from every key column", async () => {
        expect.assertions(3);

        const providerApiKeys = await clientSave(undefined, "openrouter", "sk-or-v1-eeeeeeeeeeee", 1);
        const doc: Record<string, unknown> = {
            customAIProviders: { ollama: { enabled: true, encryptedKey: "", endpoint: "https://x.example", name: "x" } },
            mcpServers: [],
            providerApiKeys,
        };

        redactPreferences(doc);

        expect(JSON.stringify(doc)).not.toContain("v1:");
        expect(doc.providerApiKeys).toMatchObject({ openrouter: { enabled: true, hasKey: true, last4: "eeee" } });
        expect(doc.customAIProviders).toMatchObject({ ollama: { hasKey: false } });
    });
});
