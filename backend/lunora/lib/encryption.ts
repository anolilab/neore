/**
 * BYOK Encryption Module — AES-256-GCM with HKDF key derivation.
 *
 * Security features:
 * - HKDF (HMAC-based Key Derivation Function) derives per-purpose keys from a single master key
 * - Key versioning: ciphertext prefixed with `v1:` for future rotation support
 * - AES-256-GCM with random 12-byte IV per encryption
 * - Backward-compatible: unversioned (v0) ciphertext decrypted with legacy single-key path
 *
 * Purposes: "provider-keys", "tool-keys", "messenger-keys", "custom-providers", "connector-tokens"
 */
const { ENCRYPTION_KEY } = process.env;

// During codegen (jiti execution), env vars aren't configured.
// Allow the module to load so codegen can extract cRPC metadata.
const isCodegen = !process.env["BETTER_AUTH_SECRET"] && !process.env["PUBLIC_ORIGIN"];

// `"window" in globalThis` rather than `globalThis.window`: the Workers lib has
// no `window`, so the property access itself does not type-check.
if (!ENCRYPTION_KEY && !("window" in globalThis) && !isCodegen) {
    throw new Error("ENCRYPTION_KEY is required");
}

const baseKeyBuffer = ENCRYPTION_KEY ? Uint8Array.from(atob(ENCRYPTION_KEY), (c) => c.codePointAt(0) ?? 0) : new Uint8Array(0);

if (ENCRYPTION_KEY && baseKeyBuffer.length < 32) {
    throw new Error(`ENCRYPTION_KEY must decode to at least 32 bytes (got ${baseKeyBuffer.length}). Generate a proper key with: openssl rand -base64 32`);
}

const ALGORITHM = "AES-GCM";
const CURRENT_VERSION = "v1";

// Use the first 32 bytes of the decoded key for AES-256
const keyBuffer = baseKeyBuffer.slice(0, 32);

// ============================================================================
// Legacy (v0) key — direct AES-GCM with raw master key (backward compat only)
// ============================================================================

let legacyCryptoKey: CryptoKey | null = null;

const getLegacyCryptoKey = async (): Promise<CryptoKey> => {
    if (!legacyCryptoKey) {
        legacyCryptoKey = await crypto.subtle.importKey("raw", keyBuffer, { length: 256, name: ALGORITHM }, false, ["decrypt"]);
    }

    return legacyCryptoKey;
};

// ============================================================================
// HKDF key derivation — per-purpose 256-bit keys derived from master key
// ============================================================================

/** Valid key purposes for HKDF derivation */
export type KeyPurpose = "connector-tokens" | "custom-providers" | "device-secrets" | "messenger-keys" | "provider-keys" | "tool-keys";

// Import master key as HKDF base key material (once, cached)
let hkdfBaseKey: CryptoKey | null = null;

const getHKDFBaseKey = async (): Promise<CryptoKey> => {
    if (!hkdfBaseKey) {
        hkdfBaseKey = await crypto.subtle.importKey("raw", keyBuffer, "HKDF", false, ["deriveKey"]);
    }

    return hkdfBaseKey;
};

// Cache derived keys per purpose to avoid re-deriving on every call
const derivedKeyCache = new Map<string, CryptoKey>();

/**
 * Derive a per-purpose AES-256-GCM key from the master key using HKDF.
 * Uses SHA-256, a fixed salt, and the purpose string as info.
 * Deterministic: same master key + purpose always produces the same derived key.
 */
const getDerivedKey = async (purpose: KeyPurpose): Promise<CryptoKey> => {
    const cached = derivedKeyCache.get(purpose);

    if (cached) {
        return cached;
    }

    const baseKey = await getHKDFBaseKey();
    const encoder = new TextEncoder();

    // Fixed salt — not secret, just ensures domain separation.
    // Changing this would break all existing v1 ciphertext.
    const salt = encoder.encode("neore-byok-v1");
    const info = encoder.encode(purpose);

    const derived = await crypto.subtle.deriveKey(
        {
            hash: "SHA-256",
            info,
            name: "HKDF",
            salt,
        },
        baseKey,
        { length: 256, name: ALGORITHM },
        false,
        ["encrypt", "decrypt"],
    );

    derivedKeyCache.set(purpose, derived);

    return derived;
};

// ============================================================================
// Encrypt / Decrypt with versioning + HKDF
// ============================================================================

/**
 * Encrypt a plaintext string.
 * @param plaintext The string to encrypt
 * @param purpose HKDF key purpose (defaults to "provider-keys" for backward compat)
 * @returns Versioned ciphertext string: "v1:<base64(iv + ciphertext)>"
 */
export const encryptKey = async (plaintext: string, purpose: KeyPurpose = "provider-keys"): Promise<string> => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await getDerivedKey(purpose);
    const plaintextBytes = new TextEncoder().encode(plaintext);
    const encryptedBuffer = await crypto.subtle.encrypt({ iv, name: ALGORITHM }, key, plaintextBytes);

    // Combine IV + encrypted data into a single base64 string
    const encryptedArray = new Uint8Array(encryptedBuffer);
    const combined = new Uint8Array(iv.length + encryptedArray.length);

    combined.set(iv, 0);
    combined.set(encryptedArray, iv.length);

    const b64 = btoa(String.fromCodePoint(...combined));

    return `${CURRENT_VERSION}:${b64}`;
};

/**
 * Decrypt an encrypted string. Handles both versioned (v1:...) and
 * legacy unversioned (v0) ciphertext for backward compatibility.
 * @param encryptedData The ciphertext to decrypt
 * @param purpose HKDF key purpose (must match what was used during encryption)
 * @returns Decrypted plaintext string
 */
export const decryptKey = async (encryptedData: string, purpose: KeyPurpose = "provider-keys"): Promise<string> => {
    // Detect version prefix
    if (encryptedData.startsWith("v1:")) {
        // v1: HKDF-derived key
        const b64 = encryptedData.slice(3);
        const combined = Uint8Array.from(atob(b64), (c) => c.codePointAt(0) ?? 0);
        const iv = combined.slice(0, 12);
        const encrypted = combined.slice(12);
        const key = await getDerivedKey(purpose);
        const decryptedBuffer = await crypto.subtle.decrypt({ iv, name: ALGORITHM }, key, encrypted);

        return new TextDecoder().decode(decryptedBuffer);
    }

    // v0 (legacy): raw master key, no version prefix
    const combined = Uint8Array.from(atob(encryptedData), (c) => c.codePointAt(0) ?? 0);
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);
    const key = await getLegacyCryptoKey();
    const decryptedBuffer = await crypto.subtle.decrypt({ iv, name: ALGORITHM }, key, encrypted);

    return new TextDecoder().decode(decryptedBuffer);
};

export const maskKey = (key: string): string => {
    if (key.length <= 8) {
        return "*".repeat(key.length);
    }

    return key.slice(0, 4) + "*".repeat(key.length - 8) + key.slice(-4);
};
