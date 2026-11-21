import { requestGrantAccessToken } from "./extension-grant";

/** Refresh this long before `exp`, so a request never leaves with a token about to lapse. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * The `exp` claim of a JWT, in milliseconds, or `undefined` when the token
 * does not carry one. Decoded, NOT verified — this only schedules a refresh;
 * the backend is what verifies the token.
 */
export const tokenExpiresAt = (token: string): number | undefined => {
    const payload = token.split(".", 2)[1];

    if (!payload) {
        return undefined;
    }

    try {
        const json = atob(
            payload
                .replaceAll("-", "+")
                .replaceAll("_", "/")
                .padEnd(Math.ceil(payload.length / 4) * 4, "="),
        );
        const { exp } = JSON.parse(json) as { exp?: unknown };

        return typeof exp === "number" ? exp * 1000 : undefined;
    } catch {
        return undefined;
    }
};

/** True when the token should be replaced before use. A token without `exp` is kept. */
export const isTokenStale = (token: string, now = Date.now()): boolean => {
    const expiresAt = tokenExpiresAt(token);

    return expiresAt !== undefined && expiresAt - REFRESH_MARGIN_MS <= now;
};

let cached: string | null = null;
let inflight: Promise<string | null> | null = null;

/**
 * A current bearer token for the stored grant, fetched once and reused until
 * near expiry. `null` when signed out — the normal case, never a throw.
 */
export const getAccessToken = async (options: { force?: boolean } = {}): Promise<string | null> => {
    if (!options.force && cached && !isTokenStale(cached)) {
        return cached;
    }

    inflight ??= requestGrantAccessToken().then((token) => {
        cached = token;
        inflight = null;

        return token;
    });

    return inflight;
};

/** Forget the cached token (sign-out, or a 401 that says it is no longer good). */
export const clearAccessToken = (): void => {
    cached = null;
};
