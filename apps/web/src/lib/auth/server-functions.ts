/**
 * @file Server function wrappers for auth (should be renamed to auth.functions.ts)
 *
 * This file contains server function definitions that are safe to import from client
 * components. The build process automatically converts these to RPC calls.
 *
 * Following TanStack Start conventions, this would be named `auth.functions.ts`
 * to make the pattern explicit.
 *
 * ✅ Safe to import in client components (converted to RPC)
 * ✅ Can import from .server.ts files (server context available)
 * @see {@link ./README.md} for file organization conventions
 */

/**
 * @file Server function wrappers for auth (should be renamed to auth.functions.ts)
 *
 * This file contains server function definitions that are safe to import from client
 * components. The build process automatically converts these to RPC calls.
 *
 * Following TanStack Start conventions, this would be named `auth.functions.ts`
 * to make the pattern explicit.
 *
 * ✅ Safe to import in client components (converted to RPC)
 * ✅ Can import from .server.ts files (server context available)
 * @see {@link ./README.md} for file organization conventions
 */

import { createServerFn } from "@tanstack/react-start";

import { getSessionState, getToken } from "./server";

const getSessionToken = createServerFn({ method: "GET" }).handler(async () => await getToken());

/**
 * The session token plus what a missing one MEANS: `unauthenticated` (the
 * backend answered "no session") or `unknown` (the token fetch failed — 429,
 * 5xx, network — for a request that carries a session cookie). Route guards
 * read this so a failed read never redirects a signed-in user to sign-in.
 */
export const getSessionAuthState = createServerFn({ method: "GET" }).handler(async () => await getSessionState());

export default getSessionToken;
