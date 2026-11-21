import type { StoredGrant } from "./extension-grant";
import { readGrant, requestGrantAccessToken } from "./extension-grant";

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

/** The stored grant, or none when storage cannot be read: a signed-out answer, never a throw. */
const readGrantOrNone = async (): Promise<StoredGrant | undefined> => {
    try {
        return await readGrant();
    } catch {
        return undefined;
    }
};

/** A JWT and the grant it was minted for: a token never outlives its grant. */
let cached: { grant: string; token: string } | null = null;
let inflight: { grant: string; promise: Promise<string | null> } | null = null;
/** Set while a sign-out is out and after it: no token for the grant being ended. */
let held = false;

/**
 * A current bearer token for the stored grant, fetched once and reused until
 * near expiry. `null` when signed out — the normal case, never a throw.
 *
 * Keyed to the grant's token: after a sign-out, or another account's sign-in
 * in any panel, the next call fetches for the grant now stored instead of
 * handing out the previous one's JWT.
 */
export const getAccessToken = async (options: { force?: boolean } = {}): Promise<string | null> => {
    if (held) {
        return null;
    }

    const grant = await readGrantOrNone();

    if (!grant) {
        cached = null;

        return null;
    }

    if (!options.force && cached?.grant === grant.token && !isTokenStale(cached.token)) {
        return cached.token;
    }

    if (inflight?.grant !== grant.token) {
        const key = grant.token;
        const promise = requestGrantAccessToken(grant).then(async (token): Promise<string | null> => {
            const current = inflight?.promise === promise;

            if (current) {
                inflight = null;
            }

            // Replaced while the request was out: neither cached nor handed to
            // anyone waiting, who gets the grant stored now instead.
            const stored = await readGrantOrNone();

            if (stored?.token !== key) {
                return await getAccessToken();
            }

            if (held) {
                return null;
            }

            if (current) {
                cached = token ? { grant: key, token } : null;
            }

            return token;
        });

        inflight = { grant: key, promise };
    }

    const token = await inflight.promise;

    return held ? null : token;
};

/** Forget the cached token (sign-out, or a 401 that says it is no longer good). */
export const clearAccessToken = (): void => {
    cached = null;
};

/**
 * A sign-out began: hand out no token until `resumeAccessTokens`, though the
 * grant stays stored until the revoke answers and storage removes it.
 */
export const holdAccessTokens = (): void => {
    held = true;
    cached = null;
};

/** A session started (a new grant, or this panel's first), or a sign-out failed and kept the grant: tokens flow again. */
export const resumeAccessTokens = (): void => {
    held = false;
};
