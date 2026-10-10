/**
 * @file Client-only auth utilities (should be renamed to auth.client.ts)
 *
 * This file contains browser-specific authentication logic. Following TanStack
 * Start conventions, this would be named `auth.client.ts` to make it explicit
 * that this code only runs in the browser.
 *
 * ✅ Safe to import in client components
 * ⚠️ DO NOT import in server contexts (no access to browser APIs like window)
 * @see {@link ./README.md} for file organization conventions
 */

import { passkeyClient } from "@better-auth/passkey/client";
import { adminClient, anonymousClient, emailOTPClient, magicLinkClient, organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import environment from "../env";
import type { SessionAtomLike } from "./session-read";
import { createSessionReadFetch, isSessionChangingRequest, keepRetryingFailedSessionReads } from "./session-read";
import { getSharedSessionRead } from "./shared-session";
import { isCredentialRequest, trackCredentialRequest } from "./sign-in-lock";

/**
 * A `get-session` read that got a 429/5xx/network failure is retried here, and
 * when it still fails it reaches better-auth as an ERROR (a synthetic 503), not
 * as an empty session: the session atom keeps what it had and `getSession()`
 * callers see `{ error }` (`guest-session.ts` refuses to mint on one). See
 * `session-read.ts`.
 */
const sharedSessionRead = getSharedSessionRead();

const sessionReadFetch = createSessionReadFetch(async (input, init) => await fetch(input, init), { onExhausted: "respond", shared: sharedSessionRead });

/**
 * The session atom, the TanStack `["session"]` query and Lunora's identity
 * probe share ONE session read (`shared-session.ts`); a request that may
 * change the session drops it when it starts AND when it finishes, so the
 * re-read better-auth triggers on its success (and any read racing it) goes
 * to the network.
 */
const trackSessionChange = (input: Request | string | URL, init: RequestInit | undefined, response: Promise<Response>): Promise<Response> => {
    if (!sharedSessionRead || !isSessionChangingRequest(input, init)) {
        return response;
    }

    sharedSessionRead.invalidate();

    return response.finally(() => {
        sharedSessionRead.invalidate();
    });
};

/**
 * Better Auth client configuration for the frontend.
 *
 * Per better-auth docs: baseURL should be the frontend URL.
 * - Server-side: VITE_SITE_URL
 * - Client-side: window.location.origin
 */
export const authClient = createAuthClient({
    baseURL: globalThis.window === undefined ? (environment.VITE_SITE_URL as string | undefined) : globalThis.location.origin,
    fetchOptions: {
        // Every credential flow funnels through this fetch, which is what makes
        // it the right place to publish "a sign-in is in flight" — see
        // `sign-in-lock.ts`. Pass-through otherwise; nothing here alters the
        // request.
        customFetchImpl: (input: Request | string | URL, init?: RequestInit) => {
            let url: string;

            if (typeof input === "string") {
                url = input;
            } else if (input instanceof URL) {
                url = input.href;
            } else {
                url = input.url;
            }

            const response = trackSessionChange(input, init, sessionReadFetch(input, init));

            return isCredentialRequest(url) ? trackCredentialRequest(response) : response;
        },
    },
    plugins: [anonymousClient(), adminClient(), twoFactorClient(), emailOTPClient(), magicLinkClient(), organizationClient(), passkeyClient()],
    sessionOptions: {
        refetchOnWindowFocus: false,
    },
});

// The atom settles a failed read and then waits for a trigger that never comes
// (focus refetch is off above), so keep re-reading until a read succeeds.
const sessionAtom = authClient.$store.atoms.session as SessionAtomLike | undefined;

if (globalThis.window !== undefined && sessionAtom) {
    keepRetryingFailedSessionReads(sessionAtom);
}

export type AuthClient = typeof authClient;
