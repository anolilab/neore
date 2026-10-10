/**
 * @file The browser's ONE session read, shared by better-auth's client and
 * Lunora's identity probe. See `createSharedSessionRead` in `session-read.ts`.
 *
 * Browser only, and that is load-bearing: on the server this module is shared
 * by every request in the process, so a cached session there would answer one
 * user's read with another's. `getSharedSessionRead()` is `undefined` during
 * SSR and callers then read on their own.
 *
 * ✅ Safe to import anywhere
 */
import type { SharedSessionRead } from "./session-read";
import { createSessionReadFetch, createSharedSessionRead } from "./session-read";

/** better-auth's cross-tab channel (`better-auth/client` `WindowBroadcastChannel`): another tab signed out or updated the user. */
const BETTER_AUTH_BROADCAST_KEY = "better-auth.message";

/** Where better-auth is mounted on the app origin (proxied to the backend, `routes/api/auth/$.ts`). */
const AUTH_BASE_PATH = "/api/auth";

/** Created on first use, once per page. */
const singleton: { shared?: SharedSessionRead } = {};

export const getSharedSessionRead = (): SharedSessionRead | undefined => {
    if (globalThis.window === undefined) {
        return undefined;
    }

    if (!singleton.shared) {
        const sessionUrl = `${globalThis.location.origin}${AUTH_BASE_PATH}/get-session`;
        const instance = createSharedSessionRead({
            // Through the app's own origin, with the session cookie — the read better-auth's client makes.
            readSession: async () => await fetch(sessionUrl, { credentials: "include", method: "GET" }),
        });

        // Another tab's sign-out / user update: better-auth re-reads on this event, and must not get our cached copy.
        // This listener must run BEFORE better-auth's (a microtask checkpoint follows each listener, so its
        // re-read could otherwise reach the cache first). Listeners run in registration order, and better-auth
        // registers on the session atom's first mount — so `lib/auth/client.ts` creates this at module load.
        globalThis.addEventListener("storage", (event) => {
            if (event.key === BETTER_AUTH_BROADCAST_KEY) {
                instance.invalidate();
            }
        });

        singleton.shared = instance;
    }

    return singleton.shared;
};

/**
 * The `fetch` for `LunoraClient`: its identity probe (`getCurrentUser`, a
 * `GET <backend>/api/auth/get-session`) answers from the shared read in the
 * browser, retries on the server, and THROWS when a read stays failed — a
 * thrown probe settles as `unreachable`, which keeps the last known identity.
 * Every other request passes straight through.
 */
export const createIdentityProbeFetch = (baseFetch: typeof fetch): ReturnType<typeof createSessionReadFetch> =>
    createSessionReadFetch(baseFetch, { onExhausted: "throw", shared: getSharedSessionRead() });
