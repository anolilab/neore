/**
 * Mints the single-use ticket the live-query socket authenticates with.
 *
 * A browser cannot set headers on a `WebSocket`, so the socket's credential rides
 * its URL — and Workers observability logs every request URL. The JWT therefore
 * never goes there: before each (re)connect the manager POSTs the bearer in a
 * header to `/_lunora/ws-ticket` and hands the socket the ticket it gets back,
 * which the backend exchanges once and which expires 30s after minting
 * (`backend/lunora/lib/ws-ticket.ts`).
 */

/** Must match `WS_TICKET_PATH` in `backend/lunora/lib/ws-ticket.ts`. */
export const WS_TICKET_PATH = "/_lunora/ws-ticket";

/** A mint that hangs would hold the socket's connect attempt; the client retries after a throw. */
export const WS_TICKET_TIMEOUT_MS = 10_000;

export type WsTicketMinter = (bearer: string) => Promise<string | undefined>;

/**
 * `undefined` when the backend does not accept the bearer (401): the socket then
 * opens anonymously, as it did when an expired JWT rode the URL. Any other
 * failure THROWS, which `LunoraClient` turns into its reconnect backoff rather
 * than a silently anonymous socket.
 */
export const createWsTicketMinter =
    (origin: string, fetchImpl: typeof fetch = async (input, init) => await globalThis.fetch(input, init)): WsTicketMinter =>
    async (bearer) => {
        const response = await fetchImpl(new URL(WS_TICKET_PATH, origin), {
            headers: { Authorization: `Bearer ${bearer}` },
            method: "POST",
            signal: AbortSignal.timeout(WS_TICKET_TIMEOUT_MS),
        });

        if (!response.ok) {
            await response.body?.cancel();

            if (response.status === 401) {
                return undefined;
            }

            throw new Error(`ws-ticket: ${String(response.status)} ${response.statusText}`);
        }

        const { ticket } = (await response.json()) as { ticket?: unknown };

        if (typeof ticket !== "string" || ticket === "") {
            throw new Error("ws-ticket: response carried no ticket");
        }

        return ticket;
    };
