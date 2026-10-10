/**
 * HMAC Stream Token — Gateway Side
 *
 * Creates and verifies signed tokens for client → gateway SSE streaming auth.
 * Token format: {streamId}:{userId}:{threadId}:{expiresAt}:{hmacHex}
 *
 * Uses the same SIGNING_SECRET shared between the backend and Gateway.
 */

/** Stream token TTL: 30 minutes (20min stream TTL + 10min buffer) */
const STREAM_TOKEN_TTL_MS = 30 * 60 * 1000;

const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Timing-safe hex string comparison via HMAC double-signing.
 */
const timingSafeEqual = async (secret: string, a: string, b: string): Promise<boolean> => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const sigA = await crypto.subtle.sign("HMAC", key, encoder.encode(a));
    const sigB = await crypto.subtle.sign("HMAC", key, encoder.encode(b));

    const viewA = new Uint8Array(sigA);
    const viewB = new Uint8Array(sigB);

    let diff = 0;

    for (const [i, element] of viewA.entries()) {
        diff |= element! ^ viewB[i]!;
    }

    return diff === 0;
};

export interface StreamTokenPayload {
    streamId: string;
    threadId: string;
    userId: string;
}

/**
 * Create an HMAC-signed stream token for client → gateway auth.
 */
export const createStreamToken = async (streamId: string, userId: string, threadId: string, secret: string): Promise<string> => {
    // Validate inputs don't contain the delimiter to prevent token parsing issues
    for (const [name, value] of [
        ["streamId", streamId],
        ["userId", userId],
        ["threadId", threadId],
    ] as const) {
        if (value.includes(":")) {
            throw new Error(`Stream token field "${name}" must not contain ":"`);
        }
    }

    const expiresAt = (Date.now() + STREAM_TOKEN_TTL_MS).toString();
    const message = `${streamId}\n${userId}\n${threadId}\n${expiresAt}`;
    const hmac = await hmacSha256Hex(secret, message);

    return `${streamId}:${userId}:${threadId}:${expiresAt}:${hmac}`;
};

/**
 * Verify an HMAC-signed stream token.
 * Throws on invalid/expired tokens.
 */
export const verifyStreamToken = async (token: string, secret: string): Promise<StreamTokenPayload> => {
    const parts = token.split(":");

    if (parts.length !== 5) {
        throw new Error("Invalid stream token format");
    }

    const [streamId, userId, threadId, expiresAtString, hmac] = parts as [string, string, string, string, string];

    // Check expiry
    const expiresAt = Number(expiresAtString);

    if (Number.isNaN(expiresAt) || Date.now() > expiresAt) {
        throw new Error("Stream token expired");
    }

    // Verify HMAC
    const message = `${streamId}\n${userId}\n${threadId}\n${expiresAtString}`;
    const expected = await hmacSha256Hex(secret, message);
    const valid = await timingSafeEqual(secret, hmac, expected);

    if (!valid) {
        throw new Error("Invalid stream token signature");
    }

    return { streamId, threadId, userId };
};
