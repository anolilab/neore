/**
 * HMAC Stream Token — Backend Side
 *
 * Creates signed tokens that clients present to the Gateway for SSE streaming.
 * Token format: {streamId}:{userId}:{threadId}:{expiresAt}:{hmacHex}
 *
 * The gateway verifies these for the browser relay; `verifyStreamToken` below
 * does the same for the public API's backend relay (`public-api/router.ts`).
 */

import { hmacSha256Hex, timingSafeEqual } from "../../../lib/crypto";

/** Stream token TTL: 30 minutes (20min stream TTL + 10min buffer) */
const STREAM_TOKEN_TTL_MS = 30 * 60 * 1000;

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

export interface StreamTokenPayload {
    streamId: string;
    threadId: string;
    userId: string;
}

/**
 * Verify a token minted by `createStreamToken`. Returns `null` — never throws —
 * for a malformed, expired or forged token; mirrors the gateway's verifier.
 */
export const verifyStreamToken = async (token: string, secret: string, now: number = Date.now()): Promise<StreamTokenPayload | null> => {
    const parts = token.split(":");

    if (parts.length !== 5) {
        return null;
    }

    const [streamId, userId, threadId, expiresAtString, hmac] = parts as [string, string, string, string, string];
    const expiresAt = Number(expiresAtString);

    if (!Number.isFinite(expiresAt) || now > expiresAt) {
        return null;
    }

    const expected = await hmacSha256Hex(secret, `${streamId}\n${userId}\n${threadId}\n${expiresAtString}`);

    return timingSafeEqual(hmac, expected) ? { streamId, threadId, userId } : null;
};
