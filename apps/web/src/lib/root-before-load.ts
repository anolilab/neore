import { tokenStillValid } from "@neore/client-runtime";

import { getSessionAuthState } from "@/lib/auth/server-functions";
import { sessionChangeCount } from "@/lib/auth/shared-session";
import { OFFLINE_SHELL_PATH, offlineShellRootContext } from "@/lib/offline-shell";
import { readRequestContext } from "@/lib/request-context";

interface RootBeforeLoadOptions {
    context: { lunoraClient: { getAuthToken: () => string | null; setAuthToken: (token: string) => void } };
    location: { pathname: string };
}

/**
 * How long a signed-in read is trusted. Past it the next navigation asks again, so a session ended
 * from another device still reaches the route guards within this time, not only at token renewal.
 */
export const CONFIRMED_READ_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Browser only: when, and at which `sessionChangeCount()`, the session was last read and found
 * signed in. The page starts at 0 with the token the server rendered it with
 * (`seedHydratedAuthToken`), which is that read.
 */
const confirmed: { at: number; changes: number | undefined } = { at: Date.now(), changes: 0 };

/**
 * The token a client navigation may keep without asking the server: the one the client holds,
 * while it has more than a minute left, the session was read as signed in less than
 * `CONFIRMED_READ_MAX_AGE_MS` ago, and nothing has possibly changed it since (`sessionChangeCount`).
 * Anything else (no token, near expiry, a sign-in or sign-out, a return to the tab) reads the
 * session as the first load does.
 *
 * What this skips is one server-function round trip per navigation, nothing the backend
 * checks: every RPC still carries the token, which the backend verifies. `AuthRecovery`
 * renews the token and drops it when the session has ended, and the next navigation then
 * reads the session again.
 */
const reusableToken = (client: RootBeforeLoadOptions["context"]["lunoraClient"]): string | undefined => {
    if (import.meta.env.SSR || confirmed.changes !== sessionChangeCount() || Date.now() - confirmed.at > CONFIRMED_READ_MAX_AGE_MS) {
        return undefined;
    }

    const token = client.getAuthToken();

    return token && tokenStillValid(token) ? token : undefined;
};

/**
 * The root route's `beforeLoad` (`src/routes/__root.tsx`), here so it can be
 * tested without importing the whole root module.
 */
const rootBeforeLoad = async (options: RootBeforeLoadOptions) => {
    // The offline shell is kept on disk by the service worker: render it for nobody, never read the session.
    // Server-only: the worker serves the kept HTML under the window's own URL, so the client never runs this branch.
    if (import.meta.env.SSR && options.location.pathname === OFFLINE_SHELL_PATH) {
        const { nonce } = await readRequestContext(options);

        return offlineShellRootContext(nonce);
    }

    const reused = reusableToken(options.context.lunoraClient);

    if (reused) {
        const { nonce, posthog } = await readRequestContext(options);

        return { authStatus: "authenticated" as const, isAuthenticated: true, nonce, token: reused, posthog };
    }

    // Taken before the read: a change while it is out leaves the answer unconfirmed.
    const changesAtRead = sessionChangeCount();
    const readAt = Date.now();

    // CSP nonce (security-middleware) and PostHog flags (posthog-middleware)
    // arrive as `serverContext`, not on the router context — see
    // `readRequestContext`. Read in parallel with the token: during SSR both
    // are network round trips on the TTFB path.
    // A failed token read (offline, 5xx, network) is `unknown`, not a thrown error: a throw
    // here replaces the whole document with the error component.
    const [{ status: authStatus, token }, { nonce, posthog }] = await Promise.all([
        getSessionAuthState().catch(() => {
            return { status: "unknown" as const, token: undefined };
        }),
        readRequestContext(options),
    ]);

    if (token) {
        options.context.lunoraClient.setAuthToken(token);
    }

    // Only a signed-in answer is reused; `unknown` and `unauthenticated` are asked again next time.
    if (!import.meta.env.SSR) {
        confirmed.at = readAt;
        confirmed.changes = authStatus === "authenticated" && token ? changesAtRead : undefined;
    }

    return {
        // `unknown` = the token fetch FAILED (429/5xx/network) for a request with a
        // session cookie. Guards redirect only on `unauthenticated` — see `lib/auth/route-guard.ts`.
        authStatus,
        isAuthenticated: !!token,
        nonce,
        token,
        posthog,
    };
};

export default rootBeforeLoad;
