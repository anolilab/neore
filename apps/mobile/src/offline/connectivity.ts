import type { ConnectionStatus } from "@lunora/client";

export interface Connectivity {
    /** The device's network: false is "no connection", undefined is not known yet. */
    network: boolean | undefined;
    /** The last read failed on the network and no read has worked since. */
    requestFailed: boolean;
    /** The live socket's aggregate status. */
    socket: ConnectionStatus | undefined;
}

export const INITIAL_CONNECTIVITY: Connectivity = { network: undefined, requestFailed: false, socket: undefined };

export type ConnectivityEvent
    = { network: boolean; type: "network" } | { socket: ConnectionStatus; type: "socket" } | { type: "request-failed" } | { type: "request-succeeded" };

export const reduceConnectivity = (state: Connectivity, event: ConnectivityEvent): Connectivity => {
    switch (event.type) {
        case "network": {
            // A network that just came back may be fine: forget the failure and let the next refresh decide.
            return { ...state, network: event.network, requestFailed: event.network ? false : state.requestFailed };
        }
        case "request-failed": {
            return { ...state, requestFailed: true };
        }
        case "request-succeeded": {
            return { ...state, requestFailed: false };
        }
        case "socket": {
            return { ...state, socket: event.socket };
        }
        default: {
            return state;
        }
    }
};

/** Offline means no connection or the live socket is down. An idle socket is not down: nothing may have asked for one. */
export const isOffline = (state: Connectivity): boolean => state.network === false || state.socket === "offline" || state.requestFailed;

/** A read that failed without the server answering, as opposed to the server refusing it. */
export const isNetworkFailure = (error: unknown): boolean => error instanceof TypeError || (error instanceof Error && error.name === "TransportError");
