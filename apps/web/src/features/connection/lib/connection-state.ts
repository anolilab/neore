import type { ConnectionStatus } from "@lunora/client";

/** What the connection banner shows. `online` renders nothing. */
export type ConnectionView = "offline" | "online" | "reconnecting";

export interface ConnectionState {
    /** `navigator.onLine`, as the browser reports it. */
    readonly browserOnline: boolean;
    /** Whether a live socket has been open during this page load. */
    readonly hasConnected: boolean;
    /** Aggregate live-socket status from the Lunora client. */
    readonly live: ConnectionStatus;
}

export type ConnectionEvent = { online: boolean; type: "browser" } | { status: ConnectionStatus; type: "live" };

export const initialConnectionState = (browserOnline: boolean): ConnectionState => {
    return { browserOnline, hasConnected: false, live: "idle" };
};

export const reduceConnection = (state: ConnectionState, event: ConnectionEvent): ConnectionState => {
    if (event.type === "browser") {
        return { ...state, browserOnline: event.online };
    }

    return {
        ...state,
        hasConnected: state.hasConnected || event.status === "connected",
        live: event.status,
    };
};

/**
 * The banner's view of a state. A dropped socket reads as `reconnecting` even
 * before the first connect, because `offline` means the backend cannot be
 * reached. `connecting` only counts once a socket has been open, so first
 * paint never shows the banner.
 */
export const connectionViewOf = (state: ConnectionState): ConnectionView => {
    if (!state.browserOnline) {
        return "offline";
    }

    return state.live === "offline" || (state.hasConnected && state.live === "connecting") ? "reconnecting" : "online";
};
