/**
 * Sign-in through the extension grant (backend/lunora/auth/extension-grant.ts):
 * PKCE authorization-code flow, then a long-lived session token that is traded
 * for a short-lived JWT. Pure: `fetch`, the digest and the secret store are
 * injected, so this file has no Expo or React Native imports and runs under
 * vitest in node. The Expo glue lives in sign-in.ts and secure-store.ts.
 */

import { trimTrailing } from "../lib/trim-trailing";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Only what the app keeps at rest: the long-lived session token, never the JWT. */
export interface StoredGrant {
    token: string;
    user: GrantUser;
}

export interface GrantUser {
    email: string;
    id: string;
    image: string | null;
    name: string;
}

/** The persistence seam. The app passes expo-secure-store; tests pass a Map. */
export interface GrantStore {
    clear: () => Promise<void>;
    get: () => Promise<StoredGrant | null>;
    set: (grant: StoredGrant) => Promise<void>;
}

export class SignInError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "SignInError";
    }
}

/** Standard base64 -> base64url without padding (RFC 7636 section 3). */
export const toBase64Url = (base64: string): string => trimTrailing(base64.replaceAll("+", "-").replaceAll("/", "_"), "=");

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary);
};

export interface PkceDependencies {
    /** SHA-256 of a UTF-8 string, base64 encoded (expo-crypto `digestStringAsync` with Base64). */
    digestBase64: (input: string) => Promise<string>;
    randomBytes: (count: number) => Uint8Array;
}

export interface PkcePair {
    challenge: string;
    state: string;
    verifier: string;
}

/** 32 random bytes -> 43-character verifier, S256 challenge, and an unguessable state. */
export const createPkce = async ({ digestBase64, randomBytes }: PkceDependencies): Promise<PkcePair> => {
    const verifier = toBase64Url(bytesToBase64(randomBytes(32)));
    const challenge = toBase64Url(await digestBase64(verifier));
    const state = toBase64Url(bytesToBase64(randomBytes(16)));

    return { challenge, state, verifier };
};

const encodeQuery = (params: Record<string, string>): string =>
    Object.entries(params)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");

/**
 * The web page that signs the user in and approves the grant. Built by string
 * concatenation: RN's URL polyfill is not something to trust with query strings.
 */
export const buildAuthorizeUrl = (input: { appUrl: string; challenge: string; redirectUri: string; state: string }): string =>
    `${trimTrailing(input.appUrl, "/")}/auth/extension?${encodeQuery({
        code_challenge: input.challenge,
        redirect_uri: input.redirectUri,
        state: input.state,
    })}`;

/** A stray `%` makes decodeURIComponent throw URIError; sign-in reports it as its own error instead. */
const decodeComponent = (raw: string): string => {
    try {
        return decodeURIComponent(raw.replaceAll("+", " "));
    } catch {
        throw new SignInError("Sign-in returned an unreadable address. Try again.");
    }
};

const parseQuery = (query: string): Record<string, string> => {
    const params: Record<string, string> = {};

    for (const pair of query.split("&")) {
        if (!pair) {
            continue;
        }

        const eq = pair.indexOf("=");
        const rawKey = eq === -1 ? pair : pair.slice(0, eq);
        const rawValue = eq === -1 ? "" : pair.slice(eq + 1);

        params[decodeComponent(rawKey)] = decodeComponent(rawValue);
    }

    return params;
};

/**
 * The code from the callback URL the browser session resolved with. The URL must
 * BEGIN with the redirect URI as a string. A URL parser is not used: for a custom
 * scheme such as `neore-mobile:` the origin is "null", so an origin comparison
 * would reject every real callback.
 */
export const parseAuthorizeResponse = (responseUrl: string | undefined, input: { redirectUri: string; state: string }): string => {
    if (!responseUrl) {
        throw new SignInError("Sign-in was cancelled.");
    }

    if (!responseUrl.startsWith(input.redirectUri)) {
        throw new SignInError("Sign-in returned to an unexpected address.");
    }

    const rest = responseUrl.slice(input.redirectUri.length);

    if (rest !== "" && rest[0] !== "?" && rest[0] !== "#") {
        throw new SignInError("Sign-in returned to an unexpected address.");
    }

    const hash = rest.indexOf("#");
    const query = rest.slice(1, hash === -1 ? undefined : hash);
    const params = parseQuery(rest[0] === "?" ? query : "");

    if (params.state !== input.state) {
        throw new SignInError("Sign-in response did not match this request. Try again.");
    }

    if (params.error) {
        throw new SignInError(params.error === "access_denied" ? "Sign-in was declined." : "Sign-in failed.");
    }

    if (!params.code) {
        throw new SignInError("Sign-in did not return a code.");
    }

    return params.code;
};

const readError = async (response: Response): Promise<string> => {
    try {
        const body = (await response.json()) as { message?: string };

        return body.message ?? `Sign-in failed (${response.status}).`;
    } catch {
        return `Sign-in failed (${response.status}).`;
    }
};

/** Bounds every auth request: a stalled exchange, refresh or revoke would otherwise leave sign-in or sign-out pending forever. */
const AUTH_REQUEST_TIMEOUT_MS = 15_000;

const postJson = async (fetch: Fetch, url: string, body: unknown): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);

    try {
        return await fetch(url, {
            body: JSON.stringify(body),
            // No cookies: the grant path is bearer-only, like the Firefox extension.
            credentials: "omit",
            headers: { "Content-Type": "application/json" },
            method: "POST",
            signal: controller.signal,
        });
    } catch (error) {
        if (controller.signal.aborted) {
            throw new SignInError("Sign-in timed out. Try again.");
        }

        throw error;
    } finally {
        clearTimeout(timer);
    }
};

/** The exchange body as a `StoredGrant`, or a `SignInError`: nothing unchecked reaches the store. */
const readGrant = async (response: Response): Promise<StoredGrant> => {
    let body: unknown;

    try {
        body = await response.json();
    } catch {
        throw new SignInError("Sign-in failed. Try again.");
    }

    const { token, user } = (typeof body === "object" && body !== null ? body : {}) as { token?: unknown; user?: unknown };

    if (typeof token !== "string" || token === "" || typeof user !== "object" || user === null || typeof (user as { id?: unknown }).id !== "string") {
        throw new SignInError("Sign-in failed. Try again.");
    }

    return { token, user: user as GrantUser };
};

/**
 * Trade the code for the session token and keep ONLY that token and the user.
 * On any failure nothing is stored and the reason comes back as `SignInError`.
 */
export const exchangeGrant = async (input: {
    code: string;
    fetch: Fetch;
    lunoraUrl: string;
    redirectUri: string;
    store: GrantStore;
    verifier: string;
}): Promise<GrantUser> => {
    const response = await postJson(input.fetch, `${input.lunoraUrl}/extension/auth/exchange`, {
        code: input.code,
        codeVerifier: input.verifier,
        redirectUri: input.redirectUri,
    });

    if (!response.ok) {
        throw new SignInError(await readError(response));
    }

    const grant = await readGrant(response);

    await input.store.set(grant);

    return grant.user;
};

/**
 * A short-lived JWT for the stored grant, or `null` when the user is signed out:
 * no grant, a 401 (the session is gone), or a 403 (the account is refused, as a
 * guest or a suspended account is). Either drops the grant, so the provider does not
 * retry a session the server will not accept. Any other failure throws and keeps the grant.
 */
export const fetchAccessToken = async (input: { fetch: Fetch; lunoraUrl: string; store: GrantStore }): Promise<string | null> => {
    const grant = await input.store.get();

    if (!grant) {
        // eslint-disable-next-line unicorn/no-null -- a signed-out result is null by contract; auth-context compares with null
        return null;
    }

    let response: Response;

    try {
        response = await postJson(input.fetch, `${input.lunoraUrl}/extension/auth/token`, { token: grant.token });
    } catch {
        throw new Error("Could not reach the server. Try again.");
    }

    if (response.status === 401 || response.status === 403) {
        await input.store.clear();

        // eslint-disable-next-line unicorn/no-null -- a signed-out result is null by contract; auth-context compares with null
        return null;
    }

    if (!response.ok) {
        await response.body?.cancel();

        throw new Error("Could not reach the server. Try again.");
    }

    const { token } = (await response.json()) as { token: string };

    return token;
};

/** Revoke the session server-side, then forget it even if the revoke fails. */
export const signOutGrant = async (input: { fetch: Fetch; lunoraUrl: string; store: GrantStore }): Promise<void> => {
    try {
        const grant = await input.store.get();

        if (grant) {
            const response = await postJson(input.fetch, `${input.lunoraUrl}/extension/auth/revoke`, { token: grant.token });

            await response.body?.cancel();
        }
    } catch {
        // Offline, or the stored grant could not be read: the session expires on its own, and the local copy is cleared below.
    } finally {
        await input.store.clear();
    }
};

/**
 * The stored user, or null when there is none or the store cannot be read. A failed read must not
 * stop the caller: the access token is already valid, so the session carries on without a profile.
 */
export const readStoredUser = async (store: GrantStore): Promise<GrantUser | null> => {
    try {
        const stored = await store.get();

        // eslint-disable-next-line unicorn/no-null -- `AuthProvider`'s user state is `GrantUser | null`
        return stored?.user ?? null;
    } catch {
        // eslint-disable-next-line unicorn/no-null -- same contract as above
        return null;
    }
};
