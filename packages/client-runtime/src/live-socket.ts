import type { LunoraClient, Unsubscribe } from "@lunora/client";
import type { WsTicketMinter } from "./ws-ticket";
import { tokenSubject } from "./live-queries";

export type LiveSocketClient = Pick<LunoraClient, "getAuthToken" | "onAuthTokenChange" | "setWsTicket">;

/**
 * Lets the client's live-query socket authenticate. The socket never carries the
 * JWT (it would land in request logs): before each connect the provider trades
 * the current bearer for a single-use ticket. It goes in as the client's
 * `wsTicket`, which rides the upgrade URL as `?token=` where the backend redeems
 * it (`backend/lunora/lib/request-bearer.ts#requestWsTicket`); a `wsToken` would
 * only reach the connect frame, which the backend never reads. `setAuthToken` alone never
 * re-authenticates an open socket, so a change of user hands it a new provider,
 * which makes the client reconnect and resubscribe.
 */
export const wireLiveSocket = (client: LiveSocketClient, mintTicket: WsTicketMinter): Unsubscribe => {
    const provider = () => async () => {
        const bearer = client.getAuthToken();

        return bearer ? await mintTicket(bearer) : undefined;
    };

    client.setWsTicket(provider());

    let subject = tokenSubject(client.getAuthToken());

    return client.onAuthTokenChange((token) => {
        const next = tokenSubject(token);

        // A routine refresh of the same user's token keeps the socket.
        if (next === subject) {
            return;
        }

        subject = next;
        client.setWsTicket(provider());
    });
};
