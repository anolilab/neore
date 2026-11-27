import type { SessionAuthStatus } from "@neore/client-runtime";

import type { RequestContextData } from "@/lib/request-context";

/**
 * The page the service worker keeps for the desktop shell's offline cold start
 * (`public/offline-shell-sw.js`). It renders the root route only, and the
 * client loads the rest for whatever URL the window asked for.
 */
export const OFFLINE_SHELL_PATH = "/offline-shell";

export interface OfflineShellRootContext {
    authStatus: SessionAuthStatus;
    isAuthenticated: false;
    nonce: string | undefined;
    posthog: RequestContextData["posthog"];
    token: undefined;
}

/**
 * The root `beforeLoad` context of the offline shell: nobody's. The session is
 * never read, so no token or user data reaches the HTML that is kept on disk,
 * whoever's cookie came with the request. `unknown`, not `unauthenticated`: a
 * guard redirects only on an answered "no session", and offline is no answer.
 */
export const offlineShellRootContext = (nonce: string | undefined): OfflineShellRootContext => {
    return {
        authStatus: "unknown",
        isAuthenticated: false,
        nonce,
        posthog: { distinctId: null, flags: {} },
        token: undefined,
    };
};
