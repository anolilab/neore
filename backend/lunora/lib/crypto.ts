/**
 * The backend's one set of signing primitives: constant-time comparison, HMAC /
 * SHA digests in the encodings webhooks and services put on the wire, and the
 * replay-window check.
 *
 * Every verifier — messenger adapters, trigger webhooks, the Resend webhook,
 * service-to-service signatures, stream tokens, pairing codes, the admin seed
 * route — compares with {@link timingSafeEqual} rather than rolling its own, so
 * there is exactly one comparison loop to get right. `===` on a signature leaks
 * how many leading bytes matched; the XOR accumulator below does not. Lengths
 * are not secret here (every compared value is a fixed-length digest or a
 * token whose length is public), so a length mismatch returns early.
 */

const encoder = new TextEncoder();

type BytesLike = ArrayBuffer | Uint8Array;

const toBytes = (value: BytesLike | string): Uint8Array => {
    if (typeof value === "string") {
        return encoder.encode(value);
    }

    return value instanceof Uint8Array ? value : new Uint8Array(value);
};

/** Constant-time byte comparison. A length mismatch returns false straight away (lengths are not secret). */
export const timingSafeEqualBytes = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) {
        return false;
    }

    let diff = 0;

    for (const [index, byte] of a.entries()) {
        diff |= byte ^ b[index]!;
    }

    return diff === 0;
};

/** Constant-time string comparison over the UTF-8 bytes. */
export const timingSafeEqual = (a: string, b: string): boolean => timingSafeEqualBytes(encoder.encode(a), encoder.encode(b));

/**
 * Constant-time comparison that also hides the LENGTH: both sides are hashed
 * first, so the loop always runs over 32 bytes. For a presented secret whose
 * length is itself worth hiding (an admin token), not for fixed-length digests.
 */
export const secretsMatch = async (presented: string, expected: string): Promise<boolean> => {
    const [a, b] = await Promise.all([sha256Bytes(presented), sha256Bytes(expected)]);

    return timingSafeEqualBytes(a, b);
};

export const bytesToHex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary);
};

/** Decodes standard base64; throws on malformed input, so callers treat a throw as "invalid". */
export const base64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.codePointAt(0)!);

/** HMAC-SHA256 of `message` under `secret` (UTF-8 text, or raw key bytes). */
export const hmacSha256 = async (secret: BytesLike | string, message: BytesLike | string): Promise<Uint8Array> => {
    const key = await crypto.subtle.importKey("raw", toBytes(secret) as BufferSource, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);

    return new Uint8Array(await crypto.subtle.sign("HMAC", key, toBytes(message) as BufferSource));
};

export const hmacSha256Hex = async (secret: BytesLike | string, message: BytesLike | string): Promise<string> => bytesToHex(await hmacSha256(secret, message));

export const digestHex = async (algorithm: "SHA-1" | "SHA-256", message: BytesLike | string): Promise<string> =>
    bytesToHex(new Uint8Array(await crypto.subtle.digest(algorithm, toBytes(message) as BufferSource)));

export const sha256Hex = async (message: BytesLike | string): Promise<string> => await digestHex("SHA-256", message);

export const sha256Bytes = async (message: BytesLike | string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", toBytes(message) as BufferSource));

/**
 * Whether `timestampMs` lies within `windowMs` of `nowMs`, in either direction.
 * A non-finite timestamp (missing header, garbage) is never fresh.
 */
export const isWithinWindow = (timestampMs: number, windowMs: number, nowMs: number = Date.now()): boolean =>
    Number.isFinite(timestampMs) && Math.abs(nowMs - timestampMs) <= windowMs;

/**
 * Five minutes: how far a signed THIRD-PARTY webhook's timestamp may be from
 * now — Slack, Discord, Feishu, WeChat, Resend (Svix) and trigger webhooks all
 * use it. Service-to-service requests we sign ourselves use the tighter
 * `SERVICE_REQUEST_WINDOW_MS` (`lib/sign-request.ts`), which must match the
 * services' own verifiers.
 */
export const SIGNED_REQUEST_WINDOW_MS = 5 * 60 * 1000;
