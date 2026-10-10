/**
 * @file Server-only auth utilities (should be renamed to auth.server.ts)
 *
 * This file contains server-side authentication logic that should NEVER be bundled
 * to the client. Following TanStack Start conventions, this would be named
 * `auth.server.ts` to make the restriction explicit at build time.
 *
 * ⚠️ DO NOT import this file in client components - use auth.functions.ts instead
 * ✅ Safe to `import type` from this file for TypeScript types
 * @see {@link ./README.md} for file organization conventions
 */

import { isAuthError } from "../utilities";
import lunoraBetterAuthReactStart from "./lunora-auth-start";

export const { fetchAuthAction, fetchAuthMutation, fetchAuthQuery, getSessionState, getToken, handler } = lunoraBetterAuthReactStart({
    // better-auth's `cookiePrefix` for this app (see `backend/lunora/auth.ts`).
    // The default is "better-auth", under which no cookie of ours exists.
    cookiePrefix: "neore",
    // The cache is now a server-process map keyed by the session cookie, not the
    // `<prefix>.lunora_jwt` cookie nothing ever wrote — see `lunora-auth-start.ts`
    // for why the token stays server-side.
    jwtCache: {
        enabled: true,
        isAuthError,
    },
    // One worker serves both the RPC and the auth routes, so both take the same origin.
    lunoraSiteUrl: import.meta.env.VITE_LUNORA_URL,
    lunoraUrl: import.meta.env.VITE_LUNORA_URL,
});
