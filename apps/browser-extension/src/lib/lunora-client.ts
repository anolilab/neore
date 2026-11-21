import { LunoraClient } from "@lunora/client";

import { LUNORA_URL } from "./env";

/**
 * The client asks for `credentials: "include"` on every request. The extension
 * authenticates with its grant's bearer alone, so no cookie the browser holds
 * for the backend's origin may ride along (`lib/extension-grant.ts`).
 */
const fetchWithoutCookies: typeof fetch = async (input, init) => await fetch(input, { ...init, credentials: "omit" });

/**
 * The one Lunora client for the panel. Its own module so `lunora.tsx` exports
 * components only, which is what Fast Refresh needs to hot-swap it.
 */
export const lunora = new LunoraClient({ fetch: fetchWithoutCookies, url: LUNORA_URL });
