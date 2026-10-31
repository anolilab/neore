import type { ConnectionStatus } from "@lunora/client";
import { TransportError } from "@lunora/client";

export interface Connectivity {
    /** The device's network: false is "no connection", undefined is not known yet. */
    network: boolean | undefined;
    /** The network reported back after an outage, and no request has worked since. Reads may run; writes wait. */
    recovering: boolean;
    /** The last read failed on the network and no read has worked since. */
    requestFailed: boolean;
    /** The live socket's aggregate status. */
    socket: ConnectionStatus | undefined;
    /** Signed in, but no token could be minted (the server was not reached on a cold start). */
    tokenMissing: boolean;
}

export const INITIAL_CONNECTIVITY: Connectivity = { network: undefined, recovering: false, requestFailed: false, socket: undefined, tokenMissing: false };

export type ConnectivityEvent
    = { network: boolean; type: "network" } | { socket: ConnectionStatus; type: "socket" } | { type: "request-failed" } | { type: "request-succeeded" } | { missing: boolean; type: "token" };

/** Offline means no connection, the live socket down, a read that failed on the network, or no token for a signed-in launch. An idle socket is not down: nothing may have asked for one. */
export const isOffline = (state: Connectivity): boolean => state.network === false || state.socket === "offline" || state.requestFailed || state.tokenMissing;

export const reduceConnectivity = (state: Connectivity, event: ConnectivityEvent): Connectivity => {
    switch (event.type) {
        case "network": {
            // A network that just came back may be fine: forget the failure and let the next refresh decide. Until a
            // request has worked, writes stay off: the device's report is a hint, not a connection to the server.
            const comesBack = event.network && isOffline(state);

            return {
                ...state,
                network: event.network,
                recovering: event.network ? state.recovering || comesBack : false,
                requestFailed: event.network ? false : state.requestFailed,
            };
        }
        case "request-failed": {
            return { ...state, requestFailed: true };
        }
        case "request-succeeded": {
            // A request that worked is proof of a network, whatever the device's hint said.
            return { ...state, network: true, recovering: false, requestFailed: false };
        }
        case "socket": {
            return { ...state, socket: event.socket };
        }
        case "token": {
            return { ...state, tokenMissing: event.missing };
        }
        default: {
            return state;
        }
    }
};

/** Writes need a connection that has answered: online, and not still confirming one that just returned. */
export const canWrite = (state: Connectivity): boolean => !isOffline(state) && !state.recovering;

/**
 * Whether the device has a network. `isInternetReachable` is left out on purpose: on Android it reads false until its
 * own probe finishes, and a request that works overrides it anyway.
 */
export const isReachable = (state: { isConnected?: boolean; isInternetReachable?: boolean | null }): boolean => state.isConnected !== false;

/** What a failed `fetch` throws: React Native, browsers and Node each word it differently. */
const FETCH_FAILURE = /^(?:failed to fetch|fetch failed|load failed|network request (?:failed|timed out)|network error|lunoraclient: .*timed out)/i;

/**
 * A read that failed without the server answering, as opposed to the server refusing it: the transport error the
 * client raises when it got no verdict, a timeout, or the error `fetch` itself throws. Any other `TypeError` is a bug
 * in the app and must not read as "offline".
 */
export const isNetworkFailure = (error: unknown): boolean => {
    if (!(error instanceof Error)) {
        return false;
    }

    if (error instanceof TransportError || error.name === "TransportError" || error.name === "TimeoutError") {
        return true;
    }

    return error instanceof TypeError && FETCH_FAILURE.test(error.message);
};
