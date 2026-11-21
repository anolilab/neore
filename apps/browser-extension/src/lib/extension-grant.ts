import { hasCookieBuildReads } from "./cookie-build-trace";
import { APP_URL, LUNORA_URL } from "./env";
import { GrantRemovalError } from "./grant-removal-error";

/*
 * Sign-in for both builds. Neither uses the web app's session cookie: the
 * server must be able to tell the extension's sends from the web app's, and
 * Firefox gives every install its own random `moz-extension://<uuid>` origin,
 * which no backend could trust for credentialed CORS anyway.
 *
 * With `host_permissions` for the backend, requests from extension pages are
 * exempt from CORS, and the backend only checks `Origin` on requests that carry
 * a cookie — and refuses an extension origin's cookie outright
 * (`backend/src/extension-cookie.ts`). So the extension never sends cookies
 * (`credentials: 'omit'`, here and in `lunora-client.ts`), only bearer tokens,
 * and gets its token through an authorization-code flow with PKCE driven by
 * `identity.launchWebAuthFlow` (server side: `backend/lunora/auth/extension-grant.ts`):
 *
 * 1. Generate a verifier; open `APP_URL/auth/extension` with its S256 challenge,
 *    `identity.getRedirectURL()` (`https://<id>.chromiumapp.org/` in Chrome,
 *    `https://<hash>.extensions.allizom.org/` in Firefox) and a random `state`.
 * 2. The user signs in on the web app — any method — and approves. The page
 *    redirects to the redirect URI with a one-time `code`; the browser intercepts
 *    it and resolves `launchWebAuthFlow` with that URL, never loading it.
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

export interface StoredGrant {
    /**
     * Random, minted per sign-in: names this grant without being its secret.
     * Grants stored before it existed lack it (`grantKey`).
     */
    id?: string;
    token: string;
    user: GrantUser;
}

export const STORAGE_KEY = "neore.extensionGrant";

/** Set once a Chrome install that rode the web cookie has been told to connect; cleared by a sign-in. */
export const RECONNECT_KEY = "neore.reconnectNeeded";

/** Written on the first run of a build that signs in through the grant, so the check below runs once per install. */
const MIGRATION_KEY = "neore.authMigration";

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

/** One name for every context of this extension (panel, popup, service worker): they share the lock. */
const GRANT_LOCK = "neore.extensionGrant";

/**
 * Runs `step` alone among every grant write in this extension. Storage has no
 * compare-and-set, so a check and the write it guards hold this lock together:
 * nothing (a sign-out in another panel, say) lands between them. Without the
 * Web Locks API (never in a supported browser) the step runs unguarded.
 */
const withGrantLock = async <T>(step: () => Promise<T>): Promise<T> => {
    const locks = globalThis.navigator?.locks as LockManager | undefined;

    return locks ? await locks.request(GRANT_LOCK, step) : await step();
};

const writeGrant = async (grant: StoredGrant): Promise<void> => {
    await withGrantLock(async () => {
        await chrome.storage.local.set({ [STORAGE_KEY]: grant });
    });
};

/**
 * Change the grant `token` names, and only while it is the stored one. A
 * refresh or a revoke answers after a round trip, by which time another panel
 * may have signed out or in again: what it writes or clears must be for the
 * grant it started with. `change` returns the new grant, or `undefined` to
 * remove it.
 */
const updateGrantIf = async (token: string, change: (stored: StoredGrant) => StoredGrant | undefined): Promise<void> => {
    await withGrantLock(async () => {
        const stored = await readGrant();

        if (stored?.token !== token) {
            return;
        }

        const next = change(stored);

        await (next ? chrome.storage.local.set({ [STORAGE_KEY]: next }) : chrome.storage.local.remove(STORAGE_KEY));
    });
};

/** Changes with every sign-in, so a cache or an effect keyed on it never outlives the grant. */
export const grantKey = (grant: StoredGrant): string => grant.id ?? grant.user.id;

/**
 * Run from `runtime.onInstalled`. The Chrome build used to ride the web app's
 * cookie and stored no grant, so an UPDATE that finds no grant and no migration
 * mark may be an install that was signed in that way. Only one whose read cache
 * holds something (`hadCookieSession`, by default `hasCookieBuildReads`) was:
 * the sign-in page then says why it is back, once. A fresh install, a Firefox
 * one (it always held a grant), one nobody signed in to, and every later update
 * only write the mark.
 */
export const migrateFromCookieSession = async (input: { hadCookieSession?: () => Promise<boolean>; isFirefox: boolean; reason: string }): Promise<void> => {
    const stored = await chrome.storage.local.get([MIGRATION_KEY, STORAGE_KEY]);

    if (Object.hasOwn(stored, MIGRATION_KEY)) {
        return;
    }

    const mayHaveSession = input.reason === "update" && !input.isFirefox && !Object.hasOwn(stored, STORAGE_KEY);
    // A probe that fails says nothing about a sign-in: no notice, rather than one for nobody.
    const hadSession = mayHaveSession && (await (input.hadCookieSession ?? hasCookieBuildReads)().catch(() => false));

    await withGrantLock(async () => {
        // A sign-in that finished while the cache was read needs no notice.
        const needsReconnect = hadSession && (await readGrant()) === undefined;

        await chrome.storage.local.set({ [MIGRATION_KEY]: 1, ...(needsReconnect && { [RECONNECT_KEY]: true }) });
    });
};

export const readReconnectNeeded = async (): Promise<boolean> => {
    const stored = await chrome.storage.local.get(RECONNECT_KEY);

    return stored[RECONNECT_KEY] === true;
};

/**
 * Calls `onChange` with whether the reconnect notice is due, now and whenever
 * that changes. The panel can open before `runtime.onInstalled` has written the
 * mark, so one read at mount would miss it. Returns the unsubscribe.
 */
export const watchReconnectNeeded = (onChange: (needed: boolean) => void): (() => void) => {
    let changed = false;

    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area !== "local" || !Object.hasOwn(changes, RECONNECT_KEY)) {
            return;
        }

        changed = true;
        onChange(changes[RECONNECT_KEY]?.newValue === true);
    };

    chrome.storage.onChanged.addListener(listener);

    const load = async () => {
        const needed = await readReconnectNeeded().catch(() => false);

        // A change that arrived first is newer than this read.
        if (!changed) {
            onChange(needed);
        }
    };

    void load();

    return () => {
        chrome.storage.onChanged.removeListener(listener);
    };
};

/** Forget the grant `token` names, and only that one. */
const clearGrant = async (token: string): Promise<void> => {
    await updateGrantIf(token, () => undefined);
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

    await writeGrant({ id: randomToken(), token, user });
    await chrome.storage.local.remove(RECONNECT_KEY);

    return user;
};

/**
 * A fresh JWT for the stored grant, or `null` when signed out.
 *
 * A 401 means the session behind the grant is gone — expired, or revoked from
 * the web app's session list — so the grant is dropped and the panel falls back
 * to the sign-in page.
 */
export const requestGrantAccessToken = async (grant: StoredGrant | undefined): Promise<string | null> => {
    if (!grant) {
        return null;
    }

    try {
        const response = await postBackend("/extension/auth/token", { token: grant.token });

        if (response.status === 401) {
            await response.body?.cancel();
            await clearGrant(grant.token);

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
            await updateGrantIf(grant.token, (stored) => {
                return { ...stored, user };
            });
        }

        return token;
    } catch {
        return null;
    }
};

/**
 * Revoke the session of the grant `key` names (`grantKey`), then forget it.
 * Forgets it even if the revoke fails, but not a grant a sign-in stored while
 * the revoke was out. `"replaced"` when another grant is stored now: it is left
 * alone, unrevoked. A failed removal rejects with `GrantRemovalError`.
 */
export const signOutGrant = async (key: string): Promise<"replaced" | "signed-out"> => {
    const grant = await readGrant();

    if (!grant) {
        return "signed-out";
    }

    if (grantKey(grant) !== key) {
        return "replaced";
    }

    let revoked = false;

    try {
        const response = await postBackend("/extension/auth/revoke", { token: grant.token });

        revoked = response.ok;
        await response.body?.cancel();
    } catch {
        // Offline: the session expires on its own; the local copy goes regardless.
    }

    try {
        await clearGrant(grant.token);
    } catch (error) {
        throw new GrantRemovalError(error, revoked);
    }

    return "signed-out";
};
