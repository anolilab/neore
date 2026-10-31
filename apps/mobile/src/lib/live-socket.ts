import type { LunoraClient, Unsubscribe } from "@lunora/client";
import type { WsTicketMinter } from "@neore/client-runtime";
import { tokenSubject } from "@neore/client-runtime";

export type LiveSocketClient = Pick<LunoraClient, "getAuthToken" | "onAuthTokenChange" | "setWsToken">;

/**
 * Lets the client's live-query socket authenticate. The socket never carries the
 * JWT (it would land in request logs): before each connect the provider trades
 * the current bearer for a single-use ticket. `setAuthToken` alone never
 * re-authenticates an open socket, so a change of user hands it a new provider,
 * which makes the client reconnect and resubscribe.
 */
export const wireLiveSocket = (client: LiveSocketClient, mintTicket: WsTicketMinter): Unsubscribe => {
    const provider = () => async () => {
        const bearer = client.getAuthToken();

        return bearer ? await mintTicket(bearer) : undefined;
    };

    client.setWsToken(provider());

    let subject = tokenSubject(client.getAuthToken());

    return client.onAuthTokenChange((token) => {
        const next = tokenSubject(token);

        // A routine refresh of the same user's token keeps the socket.
        if (next === subject) {
            return;
        }

        subject = next;
        client.setWsToken(provider());
    });
};
