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
import type { SharedSessionRead } from "@neore/client-runtime";
import { createSessionReadFetch, createSharedSessionRead } from "@neore/client-runtime";

/** better-auth's cross-tab channel (`better-auth/client` `WindowBroadcastChannel`): another tab signed out or updated the user. */
const BETTER_AUTH_BROADCAST_KEY = "better-auth.message";

/** Where better-auth is mounted on the app origin (proxied to the backend, `routes/api/auth/$.ts`). */
const AUTH_BASE_PATH = "/api/auth";

/** Created on first use, once per page. `changes` counts invalidations: see `sessionChangeCount`. */
const singleton: { changes: number; shared?: SharedSessionRead } = { changes: 0 };

/**
 * How many times this page has seen the session possibly change: a sign-in, sign-out or other
 * session-changing auth request (counted when it starts and when it ends), another tab's
 * better-auth broadcast (sign-out and user updates only), or the user coming back to this tab,
 * which is how a sign-in or account switch made in another tab reaches it. A reader that remembers this number can tell whether what it last read
 * may be out of date (`root-before-load.ts`). Always 0 on the server.
 */
export const sessionChangeCount = (): number => singleton.changes;

export const getSharedSessionRead = (): SharedSessionRead | undefined => {
    if (globalThis.window === undefined) {
        return undefined;
    }

    if (!singleton.shared) {
        const sessionUrl = `${globalThis.location.origin}${AUTH_BASE_PATH}/get-session`;
        const shared = createSharedSessionRead({
            // Through the app's own origin, with the session cookie — the read better-auth's client makes.
            readSession: async () => await fetch(sessionUrl, { credentials: "include", method: "GET" }),
        });
        const instance: SharedSessionRead = {
            invalidate: () => {
                singleton.changes += 1;
                shared.invalidate();
            },
            read: shared.read,
        };

        // Another tab's sign-out / user update: better-auth re-reads on this event, and must not get our cached copy.
        // This listener must run BEFORE better-auth's (a microtask checkpoint follows each listener, so its
        // re-read could otherwise reach the cache first). Listeners run in registration order, and better-auth
        // registers on the session atom's first mount — so `lib/auth/client.ts` creates this at module load.
        globalThis.addEventListener("storage", (event) => {
            if (event.key === BETTER_AUTH_BROADCAST_KEY) {
                instance.invalidate();
            }
        });

        // better-auth broadcasts no sign-in, guest upgrade or account switch, and a cookie change fires no event:
        // whatever another tab did, the user went there to do it. Counted only, the cached read stays.
        globalThis.document.addEventListener("visibilitychange", () => {
            if (globalThis.document.visibilityState === "visible") {
                singleton.changes += 1;
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
