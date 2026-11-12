import type { ConnectionStatus } from "@lunora/client";

/** What the connection banner shows. `online` renders nothing. */
export type ConnectionView = "offline" | "online" | "reconnecting";

export interface ConnectionState {
    /** `navigator.onLine`, as the browser reports it. */
    readonly browserOnline: boolean;
    /** Whether a live socket has been open during this page load. */
    readonly hasConnected: boolean;
    /** Whether the live socket has failed to reach the backend during this page load. */
    readonly hasFailed: boolean;
    /** Aggregate live-socket status from the Lunora client. */
    readonly live: ConnectionStatus;
}

export type ConnectionEvent = { online: boolean; type: "browser" } | { status: ConnectionStatus; type: "live" };

export const initialConnectionState = (browserOnline: boolean): ConnectionState => {
    return { browserOnline, hasConnected: false, hasFailed: false, live: "idle" };
};

export const reduceConnection = (state: ConnectionState, event: ConnectionEvent): ConnectionState => {
    if (event.type === "browser") {
        return { ...state, browserOnline: event.online };
    }

    return {
        ...state,
        hasConnected: state.hasConnected || event.status === "connected",
        hasFailed: state.hasFailed || event.status === "offline",
        live: event.status,
    };
};

/**
 * The banner's view of a state. A dropped socket reads as `reconnecting` even
 * before the first connect, because `offline` means the backend cannot be
 * reached. `connecting` only counts once a socket has been open or has failed:
 * first paint never shows the banner, and a backend that cannot be reached does
 * not flicker back to `online` between the client's attempts.
 */
export const connectionViewOf = (state: ConnectionState): ConnectionView => {
    if (!state.browserOnline) {
        return "offline";
    }

    return state.live === "offline" || ((state.hasConnected || state.hasFailed) && state.live === "connecting") ? "reconnecting" : "online";
};

/**
 * Every timing in the connection UI. The banner and the reconnecting screen
 * count from the moment the view left `online`.
 */
export const CONNECTION_THRESHOLDS_MS = {
    /** How long "Back online" stays up after a reconnect the banner had shown. */
    backOnline: 3000,

    /**
     * How long the browser must report offline, once the app had connected,
     * before the full-screen view covers an app with nothing cached. Before the
     * first connect it covers at once: there is nothing to keep on screen.
     */
    offlineScreen: 20_000,

    /**
     * How long a reconnect must last before the banner shows it. The client
     * bounces its socket whenever the bearer's subject changes (sign-in, guest
     * conversion), and a flash of "Reconnecting" for that is noise. `offline`,
     * and a backend that never answered on this page load, are never delayed.
     */
    reconnectingBanner: 2000,
    /** How long a reconnect must last, once the banner shows it, before the full-screen view takes over. */
    reconnectingScreen: 60_000,
} as const;

/** How far a non-`online` view has lasted: nothing shown yet, the banner, or the full-screen view. */
export type ConnectionStage = "banner" | "pending" | "screen";

/**
 * How long after the view left `online` the banner appears. A socket bounce
 * needs a socket that was open, so before the first connect a failure shows at once.
 */
export const bannerDelayMs = (view: ConnectionView, hasConnected: boolean): number =>
    view === "reconnecting" && hasConnected ? CONNECTION_THRESHOLDS_MS.reconnectingBanner : 0;

/** How long after the view left `online` the full-screen view covers an app with nothing cached; `0` is at once. */
export const screenDelayMs = (view: Exclude<ConnectionView, "online">, hasConnected: boolean): number => {
    if (view === "offline") {
        return hasConnected ? CONNECTION_THRESHOLDS_MS.offlineScreen : 0;
    }

    return bannerDelayMs(view, hasConnected) + CONNECTION_THRESHOLDS_MS.reconnectingScreen;
};

export interface ConnectionPresentation {
    /** The banner is saying "Back online" after a reconnect it had shown. */
    readonly backOnline: boolean;
    /** The view the banner shows; `online` renders nothing. */
    readonly banner: ConnectionView;

    /**
     * The view that would cover the app when there is nothing cached to show, or `null`
     * until it has lasted `screenDelayMs` (an offline start: at once).
     */
    readonly screen: Exclude<ConnectionView, "online"> | null;
    /** The live view, with no delay: for callers that must not act as if online (auth, sending). */
    readonly view: ConnectionView;
}

/** What to show for a view that has reached `stage`. The stage must belong to the same view. */
export const connectionPresentationOf = (
    view: ConnectionView,
    stage: ConnectionStage,
    { announced = false, backOnline = false, hasConnected = true }: { announced?: boolean; backOnline?: boolean; hasConnected?: boolean } = {},
): ConnectionPresentation => {
    if (view === "online") {
        return { backOnline, banner: "online", screen: null, view };
    }

    return {
        backOnline: false,
        // Once shown, the banner stays up through the change from offline to reconnecting, with no new grace period.
        banner: announced || bannerDelayMs(view, hasConnected) === 0 || stage !== "pending" ? view : "online",
        screen: stage === "screen" || screenDelayMs(view, hasConnected) === 0 ? view : null,
        view,
    };
};
