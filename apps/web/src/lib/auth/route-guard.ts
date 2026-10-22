/**
 * @file The one sign-in guard for `beforeLoad`.
 *
 * Every guarded route used to read `if (!context.isAuthenticated) throw
 * redirect(...)`, and `isAuthenticated` is just "the root route got a token".
 * A token fetch that FAILED (better-auth answers 429 when an office NAT shares
 * one IP bucket) produced no token too, so a signed-in user was bounced to
 * sign-in. The root route now also says WHY there is no token
 * (`authStatus`, from `getSessionAuthState`), and only an answered "no session"
 * redirects. On `unknown` the page renders; `AuthRecovery` adopts the token
 * once the backend answers, and Lunora's `<Authenticated>` gate keeps showing
 * the last known identity meanwhile.
 *
 * ✅ Safe to import in client components
 */
import type { SessionAuthStatus } from "@neore/client-runtime";
import { redirect } from "@tanstack/react-router";

export interface AuthGuardContext {
    /** Absent only on a context built before the root route ran; then `isAuthenticated` decides. */
    authStatus?: SessionAuthStatus;
    isAuthenticated?: boolean;
}

/**
 * The route's location, passed by the route's own `beforeLoad` (`({ context, location })`).
 * The router context does not carry it, so a guard that reads it from `context` never sees it.
 */
export interface GuardLocation {
    href: string;
    pathname: string;
}

/** True only when the backend ANSWERED "no session" — never for a failed read. */
export const isSignedOut = (context: AuthGuardContext): boolean => {
    if (context.authStatus === undefined) {
        return !context.isAuthenticated;
    }

    return context.authStatus === "unauthenticated";
};

/** `beforeLoad` guard: send a signed-out visitor to sign-in, and nobody else. */
export const requireSession = (context: AuthGuardContext, location: GuardLocation): void => {
    if (!isSignedOut(context)) {
        return;
    }

    // Keep the destination, so a deep link or invite survives sign-in. An auth page is
    // never the destination: sending the visitor back there would loop.
    const { href, pathname } = location;
    const redirectTo = pathname.startsWith("/auth/") ? undefined : href;

    throw redirect({ to: "/auth/sign-in", search: redirectTo ? { redirectTo } : {} });
};
