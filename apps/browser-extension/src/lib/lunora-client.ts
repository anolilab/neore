import { LunoraClient } from "@lunora/client";
import { createWsTicketMinter, wireLiveSocket } from "@neore/client-runtime";

import { LUNORA_URL } from "./env";

/**
 * The client asks for `credentials: "include"` on every request. The extension
 * authenticates with its grant's bearer alone, so no cookie the browser holds
 * for the backend's origin may ride along (`lib/extension-grant.ts`).
 */
const fetchWithoutCookies: typeof fetch = async (input, init) => await fetch(input, { ...init, credentials: "omit" });

/**
 * A Lunora client that sends no cookie. Live queries run over a socket, which
 * cannot carry a header and (with no cookie) has no credential of its own: each
 * connect trades the bearer for a single-use ticket, as the web and mobile
 * clients do. `wire` is for tests.
 */
export const createLunoraClient = (url: string, wire: typeof wireLiveSocket = wireLiveSocket): LunoraClient => {
    const client = new LunoraClient({ fetch: fetchWithoutCookies, url });

    wire(client, createWsTicketMinter(url, fetchWithoutCookies));

    return client;
};

/**
 * The one Lunora client for the panel. Its own module so `lunora.tsx` exports
 * components only, which is what Fast Refresh needs to hot-swap it.
 */
export const lunora = createLunoraClient(LUNORA_URL);
