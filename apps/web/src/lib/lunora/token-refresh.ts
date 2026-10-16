/**
 * When to renew the RPC bearer. The JWT lives for its own `exp - iat` (15 minutes by
 * default). Renew at 80% of that lifetime, and no later than 80% of what is left on the
 * clock. The second bound matters for a token that was already aged when this page got
 * it: a full-lifetime timer would fire after the token had expired.
 *
 * A device clock that runs ahead can make the remaining time look short. That only
 * renews sooner, and `MIN_DELAY_MS` stops it from renewing in a tight loop. A clock that
 * runs behind leaves the 80%-of-lifetime bound in place, so a token is never held for
 * longer than its own lifetime before renewal.
 */
const REFRESH_FRACTION = 0.8;

const MIN_DELAY_MS = 30_000;

/** Retry delay after a failed or inconclusive renewal. The current token keeps working until it expires. */
export const TOKEN_RETRY_DELAY_MS = 60_000;

/**
 * Milliseconds to wait before renewing `token`, or `undefined` when its claims can't say.
 * `nowMs` is the moment the delay is measured from; it defaults to the device clock.
 */
export const tokenRefreshDelayMs = (token: string, nowMs: number = Date.now()): number | undefined => {
    const payload = token.split(".", 2)[1];

    if (!payload) {
        return undefined;
    }

    try {
        const claims = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))) as { exp?: unknown; iat?: unknown };

        if (typeof claims.exp !== "number" || typeof claims.iat !== "number" || claims.exp <= claims.iat) {
            return undefined;
        }

        const lifetimeMs = (claims.exp - claims.iat) * 1000;
        const remainingMs = claims.exp * 1000 - nowMs;
        const delayMs = REFRESH_FRACTION * Math.min(lifetimeMs, remainingMs);

        return Math.max(MIN_DELAY_MS, Math.floor(delayMs));
    } catch {
        return undefined;
    }
};
