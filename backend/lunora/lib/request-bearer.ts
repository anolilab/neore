/** The path `LunoraClient` opens its live-query socket on. */
export const LUNORA_WS_PATH = "/_lunora/ws";

/** Where `LunoraClient` re-authenticates an open socket before the server's revalidation deadline. */
export const LUNORA_WS_REAUTH_PATH = "/_lunora/ws/reauth";

/**
 * The bearer JWT a request carries in `Authorization: Bearer …`, for
 * `resolveIdentity`. Only the header: a JWT in a URL lands in Workers
 * observability logs (every request URL is logged), history and `Referer`.
 */
export const requestBearer = (request: Request): string | undefined => {
    const authorization = request.headers.get("Authorization");

    return authorization?.startsWith("Bearer ") ? authorization.slice(7) || undefined : undefined;
};

/**
 * The single-use ticket (`lib/ws-ticket.ts`) a live-query socket's upgrade
 * carries, or its re-authentication.
 *
 * A browser cannot set headers on a `WebSocket`, so the credential has to ride
 * the URL — which is logged. It is therefore never the JWT: the browser mints a
 * ticket (`POST /_lunora/ws-ticket`, bearer in the header) right before each
 * (re)connect, and the upgrade exchanges it once. By the time anyone reads the
 * log line the ticket is spent, and it expired 30s after minting regardless.
 *
 * The query parameter is `token` because that is where `LunoraClient` puts its
 * `wsTicket` (`setWsTicket`); its `wsToken` rides only the connect frame, which
 * this side never reads. What matters is that this side reads it ONLY as a
 * ticket, never as a bearer. It is honoured only on a WebSocket upgrade to the
 * socket path, and on the `POST` that re-authenticates an open socket: a client
 * holding only a ticket (no cookie, and no bearer on that request) sends a fresh
 * one there, and redeeming it keeps the socket signed in and spends the ticket
 * its URL logged.
 *
 * The runtime's own upgrade gate reads `?token=` too, but only when
 * `LUNORA_WS_BEARER` is set — and then it must EQUAL that static secret, which a
 * per-connect ticket never does. Setting `LUNORA_WS_BEARER` would therefore
 * refuse every browser socket; leave it unset.
 */
export const requestWsTicket = (request: Request): string | undefined => {
    const url = new URL(request.url);
    const isUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket" && url.pathname === LUNORA_WS_PATH;

    return isUpgrade || isWsReauth(request) ? url.searchParams.get("token") || undefined : undefined;
};

/** Whether this is the `POST` that re-authenticates an open live-query socket. */
export const isWsReauth = (request: Request): boolean => request.method === "POST" && new URL(request.url).pathname === LUNORA_WS_REAUTH_PATH;
