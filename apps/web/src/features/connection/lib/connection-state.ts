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

/**
 * Every timing in the connection UI. Both the banner and the offline screen
 * count from the moment the view left `online`.
 */
export const CONNECTION_THRESHOLDS_MS = {
    /** How long the browser must report offline before the full-screen view takes over. */
    offlineScreen: 20_000,

    /**
     * How long a reconnect must last before the banner shows it. The client
     * bounces its socket whenever the bearer's subject changes (sign-in, guest
     * conversion), and a flash of "Reconnecting" for that is noise. `offline`
     * is never delayed.
     */
    reconnectingBanner: 2000,
    /** How long a reconnect must last, once the banner shows it, before the full-screen view takes over. */
    reconnectingScreen: 60_000,
} as const;

/** How far a non-`online` view has lasted: nothing shown yet, the banner, or the full-screen view. */
export type ConnectionStage = "banner" | "pending" | "screen";

/** How long after the view left `online` the banner appears. */
export const bannerDelayMs = (view: ConnectionView): number => (view === "reconnecting" ? CONNECTION_THRESHOLDS_MS.reconnectingBanner : 0);

/** How long after the view left `online` the full-screen view appears. */
export const screenDelayMs = (view: ConnectionView): number =>
    view === "offline" ? CONNECTION_THRESHOLDS_MS.offlineScreen : CONNECTION_THRESHOLDS_MS.reconnectingBanner + CONNECTION_THRESHOLDS_MS.reconnectingScreen;

export interface ConnectionPresentation {
    /** The view the banner shows; `online` renders nothing. */
    readonly banner: ConnectionView;
    /** The view that has lasted long enough to cover the app, or `null`. */
    readonly screen: Exclude<ConnectionView, "online"> | null;
}

/** What to show for a view that has reached `stage`. The stage must belong to the same view. */
export const connectionPresentationOf = (view: ConnectionView, stage: ConnectionStage): ConnectionPresentation => {
    if (view === "online") {
        return { banner: "online", screen: null };
    }

    return {
        banner: bannerDelayMs(view) === 0 || stage !== "pending" ? view : "online",
        screen: stage === "screen" ? view : null,
    };
};
