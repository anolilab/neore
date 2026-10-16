/**
 * When to renew the RPC bearer. The JWT lives for its own `exp - iat` (15 minutes by
 * default), and nothing refreshed it, so a session left open past that fell back to
 * anonymous RPCs. Renew at 80% of the lifetime, measured from the token's own claims:
 * the device clock never enters the calculation, so a skewed clock cannot make every
 * fresh token look already due.
 */
const REFRESH_FRACTION = 0.8;

const MIN_DELAY_MS = 30_000;

/** Retry delay after a failed renewal. The current token keeps working until it expires. */
export const TOKEN_RETRY_DELAY_MS = 60_000;

/** Milliseconds to wait before renewing `token`, or `undefined` when its claims can't say. */
export const tokenRefreshDelayMs = (token: string): number | undefined => {
    const payload = token.split(".", 2)[1];

    if (!payload) {
        return undefined;
    }

    try {
        const claims = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))) as { exp?: unknown; iat?: unknown };

        if (typeof claims.exp !== "number" || typeof claims.iat !== "number" || claims.exp <= claims.iat) {
            return undefined;
        }

        return Math.max(MIN_DELAY_MS, Math.floor((claims.exp - claims.iat) * REFRESH_FRACTION * 1000));
    } catch {
        return undefined;
    }
};
