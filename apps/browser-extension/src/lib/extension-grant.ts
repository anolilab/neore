import { useEffect, useState } from "react";

import { APP_URL, LUNORA_URL } from "./env";

/*
 * Sign-in for the Firefox build, which cannot use the web app's session cookie.
 *
 * Every Firefox install has its own random `moz-extension://<uuid>` origin, so
 * the backend has no origin to trust for credentialed CORS. It does not need
 * one: with `host_permissions` for the backend, requests from extension pages
 * are exempt from CORS, and the backend only checks `Origin` on requests that
 * carry a cookie. So this build never sends cookies (`credentials: 'omit'`) —
 * only bearer tokens — and gets its token through an authorization-code flow
 * with PKCE, driven by `identity.launchWebAuthFlow` (server side:
 * `backend/lunora/auth/extension-grant.ts`):
 *
 * 1. Generate a verifier; open `APP_URL/auth/extension` with its S256 challenge,
 *    `identity.getRedirectURL()` and a random `state`.
 * 2. The user signs in on the web app — any method — and approves. The page
 *    redirects to the redirect URI with a one-time `code`; Firefox intercepts it
 *    and resolves `launchWebAuthFlow` with that URL, never loading it.
 * 3. POST code + verifier to `/extension/auth/exchange` for a session token (the
 *    "grant"), kept in `storage.local`.
 * 4. Trade the grant for a short-lived JWT at `/extension/auth/token` whenever a
 *    bearer is needed (`access-token.ts`).
 *
 * The only secret in any URL is the code: single use, a minute long, and
 * worthless without the verifier, which never leaves this extension.
 */

export interface GrantUser {
    email: string;
    id: string;
    image: string | null;
    name: string;
}

interface StoredGrant {
    token: string;
    user: GrantUser;
}

const STORAGE_KEY = "neore.extensionGrant";

const toBase64Url = (bytes: Uint8Array): string => {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    // `=` only ever appears as base64's trailing padding.
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const randomToken = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

/** RFC 7636: a 43-character verifier and its S256 challenge. */
export const createPkcePair = async (): Promise<{ challenge: string; verifier: string }> => {
    const verifier = randomToken();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));

    return { challenge: toBase64Url(new Uint8Array(digest)), verifier };
};

/** The web app page that signs the user in and approves this extension. */
export const buildAuthorizeUrl = (input: { appUrl: string; challenge: string; redirectUri: string; state: string }): string => {
    const url = new URL("/auth/extension", input.appUrl);

    url.searchParams.set("code_challenge", input.challenge);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", input.state);

    return url.href;
};

export class SignInError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "SignInError";
    }
}

/**
 * The code from the URL `launchWebAuthFlow` resolved with.
 *
 * `state` must round-trip unchanged: that is what ties this response to the
 * request this extension started. The URL must also be the redirect URI itself,
 * not something that merely contains a `code` parameter.
 */
export const parseAuthorizeResponse = (responseUrl: string | undefined, input: { redirectUri: string; state: string }): string => {
    if (!responseUrl) {
        throw new SignInError("Sign-in was cancelled.");
    }

    const url = new URL(responseUrl);

    if (`${url.origin}${url.pathname}` !== new URL(input.redirectUri).href) {
        throw new SignInError("Sign-in returned to an unexpected address.");
    }

    if (url.searchParams.get("state") !== input.state) {
        throw new SignInError("Sign-in response did not match this request. Try again.");
    }

    const error = url.searchParams.get("error");

    if (error) {
        throw new SignInError(error === "access_denied" ? "Sign-in was declined." : "Sign-in failed.");
    }

    const code = url.searchParams.get("code");

    if (!code) {
        throw new SignInError("Sign-in did not return a code.");
    }

    return code;
};

const readError = async (response: Response): Promise<string> => {
    try {
        const body = (await response.json()) as { message?: string };

        return body.message ?? `Sign-in failed (${response.status}).`;
    } catch {
        return `Sign-in failed (${response.status}).`;
    }
};

/** POST JSON to the backend with no cookies — the whole point of this path. */
const postBackend = async (path: string, body: unknown): Promise<Response> =>
    await fetch(new URL(path, LUNORA_URL), {
        body: JSON.stringify(body),
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        method: "POST",
    });

export const readGrant = async (): Promise<StoredGrant | undefined> => {
    const stored = await chrome.storage.local.get(STORAGE_KEY);

    return stored[STORAGE_KEY] as StoredGrant | undefined;
};

const writeGrant = async (grant: StoredGrant): Promise<void> => {
    await chrome.storage.local.set({ [STORAGE_KEY]: grant });
};

const clearGrant = async (): Promise<void> => {
    await chrome.storage.local.remove(STORAGE_KEY);
};

/**
 * Run the whole sign-in: web auth flow, then the code exchange. Must be called
 * from a click handler — `launchWebAuthFlow` with `interactive: true` opens a
 * window.
 */
export const signInWithWebAuthFlow = async (): Promise<GrantUser> => {
    if (!LUNORA_URL) {
        throw new SignInError("VITE_LUNORA_URL is not configured for this build.");
    }

    const redirectUri = chrome.identity.getRedirectURL();
    const { challenge, verifier } = await createPkcePair();
    const state = randomToken();

    let responseUrl: string | undefined;

    try {
        responseUrl = await chrome.identity.launchWebAuthFlow({
            interactive: true,
            url: buildAuthorizeUrl({ appUrl: APP_URL, challenge, redirectUri, state }),
        });
    } catch {
        // Closing the window rejects; there is nothing more useful to report.
        throw new SignInError("Sign-in was cancelled.");
    }

    const code = parseAuthorizeResponse(responseUrl, { redirectUri, state });
    const response = await postBackend("/extension/auth/exchange", { code, codeVerifier: verifier, redirectUri });

    if (!response.ok) {
        throw new SignInError(await readError(response));
    }

    const { token, user } = (await response.json()) as StoredGrant;

    await writeGrant({ token, user });

    return user;
};

/**
 * A fresh JWT for the stored grant, or `null` when signed out.
 *
 * A 401 means the session behind the grant is gone — expired, or revoked from
 * the web app's session list — so the grant is dropped and the panel falls back
 * to the sign-in page.
 */
export const requestGrantAccessToken = async (): Promise<string | null> => {
    const grant = await readGrant();

    if (!grant) {
        return null;
    }

    try {
        const response = await postBackend("/extension/auth/token", { token: grant.token });

        if (response.status === 401) {
            await response.body?.cancel();
            await clearGrant();

            return null;
        }

        if (!response.ok) {
            await response.body?.cancel();

            return null;
        }

        const { token, user } = (await response.json()) as { token: string; user: GrantUser };

        // Keep the shown profile current without rewriting storage (and notifying
        // every listener) on each refresh.
        if (JSON.stringify(user) !== JSON.stringify(grant.user)) {
            await writeGrant({ token: grant.token, user });
        }

        return token;
    } catch {
        return null;
    }
};

/** Revoke the session server-side, then forget it. Forgets it even if the revoke fails. */
export const signOutGrant = async (): Promise<void> => {
    const grant = await readGrant();

    try {
        if (grant) {
            const response = await postBackend("/extension/auth/revoke", { token: grant.token });

            await response.body?.cancel();
        }
    } catch {
        // Offline: the session expires on its own; the local copy goes regardless.
    } finally {
        await clearGrant();
    }
};

/** The stored grant's user, kept in step with `storage.local`. `undefined` while loading. */
export const useGrantUser = (): { isPending: boolean; user: GrantUser | null } => {
    const [user, setUser] = useState<GrantUser | null | undefined>(undefined);

    useEffect(() => {
        let cancelled = false;

        const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
            if (area === "local" && Object.hasOwn(changes, STORAGE_KEY)) {
                setUser((changes[STORAGE_KEY]?.newValue as StoredGrant | undefined)?.user ?? null);
            }
        };

        chrome.storage.onChanged.addListener(listener);

        const load = async () => {
            const grant = await readGrant();

            if (!cancelled) {
                setUser(grant?.user ?? null);
            }
        };

        void load();

        return () => {
            cancelled = true;
            chrome.storage.onChanged.removeListener(listener);
        };
    }, []);

    return { isPending: user === undefined, user: user ?? null };
};
