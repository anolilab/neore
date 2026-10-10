/**
 * Encryption for connector OAuth secrets (access/refresh tokens, DCR client
 * secrets, PKCE verifiers).
 *
 * Keyed by `CONNECTOR_ENCRYPTION_KEY` when it is set, so a leak of the BYOK
 * master key does not also expose every user's third-party grants. Without it
 * the secrets fall back to `ENCRYPTION_KEY` under their own HKDF purpose
 * (`lib/encryption.ts`), which is still domain-separated from provider keys.
 *
 * The two produce different prefixes (`c1:` vs `v1:`), so turning the dedicated
 * key on later does not strand anything already stored: old rows keep decrypting
 * through the fallback. ROTATING `CONNECTOR_ENCRYPTION_KEY` does strand them —
 * decryption fails, the connector reads as expired, and the user reconnects.
 */
import { decryptKey, encryptKey } from "../../lib/encryption";

const PREFIX = "c1:";
const ALGORITHM = "AES-GCM";

let cachedKey: { key: CryptoKey; raw: string } | null = null;

const dedicatedKey = async (): Promise<CryptoKey | null> => {
    const raw = process.env["CONNECTOR_ENCRYPTION_KEY"]?.trim() ?? "";

    if (!raw) {
        return null;
    }

    const cached = cachedKey;

    if (cached && cached.raw === raw) {
        return cached.key;
    }

    const bytes = Uint8Array.from(atob(raw), (c) => c.codePointAt(0) ?? 0);

    if (bytes.length < 32) {
        throw new Error(`CONNECTOR_ENCRYPTION_KEY must decode to at least 32 bytes (got ${bytes.length}). Generate one with: openssl rand -base64 32`);
    }

    const base = await crypto.subtle.importKey("raw", bytes.slice(0, 32), "HKDF", false, ["deriveKey"]);
    const encoder = new TextEncoder();
    const key = await crypto.subtle.deriveKey(
        { hash: "SHA-256", info: encoder.encode("connector-tokens"), name: "HKDF", salt: encoder.encode("neore-connectors-v1") },
        base,
        { length: 256, name: ALGORITHM },
        false,
        ["encrypt", "decrypt"],
    );

    cachedKey = { key, raw };

    return key;
};

export const encryptConnectorSecret = async (plaintext: string): Promise<string> => {
    const key = await dedicatedKey();

    if (!key) {
        return await encryptKey(plaintext, "connector-tokens");
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ iv, name: ALGORITHM }, key, new TextEncoder().encode(plaintext)));
    const combined = new Uint8Array(iv.length + encrypted.length);

    combined.set(iv, 0);
    combined.set(encrypted, iv.length);

    return `${PREFIX}${btoa(String.fromCodePoint(...combined))}`;
};

export const decryptConnectorSecret = async (ciphertext: string): Promise<string> => {
    if (!ciphertext.startsWith(PREFIX)) {
        return await decryptKey(ciphertext, "connector-tokens");
    }

    const key = await dedicatedKey();

    if (!key) {
        throw new Error("Connector secret was encrypted with CONNECTOR_ENCRYPTION_KEY, which is no longer set");
    }

    const combined = Uint8Array.from(atob(ciphertext.slice(PREFIX.length)), (c) => c.codePointAt(0) ?? 0);
    const decrypted = await crypto.subtle.decrypt({ iv: combined.slice(0, 12), name: ALGORITHM }, key, combined.slice(12));

    return new TextDecoder().decode(decrypted);
};

/** The token pair as it is stored: one ciphertext, so the two can never drift apart. */
export interface ConnectorTokens {
    accessToken: string;
    refreshToken?: string;
}

export const encryptConnectorTokens = async (tokens: ConnectorTokens): Promise<string> => await encryptConnectorSecret(JSON.stringify(tokens));

export const decryptConnectorTokens = async (ciphertext: string): Promise<ConnectorTokens> => {
    const parsed = JSON.parse(await decryptConnectorSecret(ciphertext)) as Partial<ConnectorTokens>;

    if (typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0) {
        throw new Error("Stored connector tokens are malformed");
    }

    return { accessToken: parsed.accessToken, ...(typeof parsed.refreshToken === "string" && { refreshToken: parsed.refreshToken }) };
};
