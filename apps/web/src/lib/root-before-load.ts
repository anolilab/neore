import { getSessionAuthState } from "@/lib/auth/server-functions";
import { OFFLINE_SHELL_PATH, offlineShellRootContext } from "@/lib/offline-shell";
import { readRequestContext } from "@/lib/request-context";

interface RootBeforeLoadOptions {
    context: { lunoraClient: { setAuthToken: (token: string) => void } };
    location: { pathname: string };
}

/**
 * The root route's `beforeLoad` (`src/routes/__root.tsx`), here so it can be
 * tested without importing the whole root module.
 */
const rootBeforeLoad = async (options: RootBeforeLoadOptions) => {
    // The offline shell is kept on disk by the service worker: render it for nobody, never read the session.
    if (options.location.pathname === OFFLINE_SHELL_PATH) {
        const { nonce } = await readRequestContext(options);

        return offlineShellRootContext(nonce);
    }

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
