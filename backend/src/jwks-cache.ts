/**
 * The isolate's copy of our JWKS, and the "re-read once on an unknown `kid`"
 * retry that makes key rotation invisible to callers.
 *
 * The forced re-read is throttled per isolate. A bearer token is
 * caller-supplied, so a `kid` that matches nothing is something anyone can
 * send; unthrottled, every such request rebuilt better-auth and re-read the
 * key set — a cheap way to make the hottest path in the app do real work per
 * request. A genuinely rotated key still verifies: the first request after
 * rotation re-reads, and later ones hit the refreshed set.
 */
import type { JSONWebKeySet, JWTVerifyOptions } from "jose";
import { createLocalJWKSet, jwtVerify } from "jose";

/** How long an isolate trusts its copy of the key set before re-reading it. */
export const JWKS_TTL_MS = 5 * 60 * 1000;

/** At most one forced (unknown-`kid`) re-read per isolate in this window. */
export const JWKS_FORCED_RELOAD_INTERVAL_MS = 30 * 1000;

type KeySet = ReturnType<typeof createLocalJWKSet>;

export interface JwksCache {
    /** Verify `token`, re-reading the key set (throttled) if no cached key matched. */
    verify: (token: string, options: JWTVerifyOptions) => ReturnType<typeof jwtVerify>;
}

export const createJwksCache = (load: () => Promise<JSONWebKeySet>, now: () => number = Date.now): JwksCache => {
    let cache: { expiresAt: number; keys: KeySet } | undefined;
    let lastForcedAt = -Infinity;

    const read = async (): Promise<KeySet> => {
        const keys = createLocalJWKSet(await load());

        cache = { expiresAt: now() + JWKS_TTL_MS, keys };

        return keys;
    };

    const current = async (): Promise<KeySet> => (cache && cache.expiresAt > now() ? cache.keys : await read());

    return {
        verify: async (token, options) => {
            try {
                return await jwtVerify(token, await current(), options);
            } catch (error) {
                if ((error as { code?: string }).code !== "ERR_JWKS_NO_MATCHING_KEY" || now() - lastForcedAt < JWKS_FORCED_RELOAD_INTERVAL_MS) {
                    throw error;
                }

                lastForcedAt = now();

                return await jwtVerify(token, await read(), options);
            }
        },
    };
};
