import { useEffect, useReducer, useState } from "react";

import { useLunora } from "@/lib/lunora/crpc";

import type { ConnectionPresentation, ConnectionStage, ConnectionView } from "../lib/connection-state";
import {
    bannerDelayMs,
    CONNECTION_THRESHOLDS_MS,
    connectionPresentationOf,
    connectionViewOf,
    initialConnectionState,
    reduceConnection,
    screenDelayMs,
} from "../lib/connection-state";

interface Lapsed {
    readonly stage: Exclude<ConnectionStage, "pending">;
    readonly view: ConnectionView;
}

/**
 * The app's connection status: what the banner and the offline screen show. It
 * subscribes to the client and the window, so mount it once (see
 * `ConnectionProvider`) and read it with `useConnection`. Starts `online` on the
 * server and on first paint; reads `navigator.onLine` after mount.
 */
export const useConnectionStatus = (): ConnectionPresentation => {
    const client = useLunora();
    const [state, dispatch] = useReducer(reduceConnection, true, initialConnectionState);
    const [lapsed, setLapsed] = useState<Lapsed | null>(null);
    const { hasConnected, live } = state;
    const [backOnline, setBackOnline] = useState(false);
    // The banner has shown this outage; it stays up until the live socket is connected again, then says "Back online".
    const [announced, setAnnounced] = useState(false);
    // An outage the banner showed is not over while the socket is still connecting, even before the first connect of the page.
    const stateView = connectionViewOf(state);
    const view = stateView === "online" && announced && live === "connecting" ? "reconnecting" : stateView;

    useEffect(() => {
        dispatch({ online: navigator.onLine, type: "browser" });

        const handleOnline = () => dispatch({ online: true, type: "browser" });
        const handleOffline = () => dispatch({ online: false, type: "browser" });

        globalThis.addEventListener("online", handleOnline);
        globalThis.addEventListener("offline", handleOffline);

        // Fires at once with the current status, then on every change.
        const unsubscribe = client.onConnectionStatus((status) => dispatch({ status, type: "live" }));

        return () => {
            globalThis.removeEventListener("online", handleOnline);
            globalThis.removeEventListener("offline", handleOffline);
            unsubscribe();
        };
    }, [client]);

    useEffect(() => {
        if (view === "online") {
            return undefined;
        }

        const bannerDelay = bannerDelayMs(view, hasConnected);
        const timers: ReturnType<typeof setTimeout>[] = [];

        const screenDelay = screenDelayMs(view, hasConnected);

        if (screenDelay > 0) {
            timers.push(setTimeout(setLapsed, screenDelay, { stage: "screen", view }));
        }

        if (bannerDelay > 0) {
            timers.push(setTimeout(setLapsed, bannerDelay, { stage: "banner", view }));
        }

        return () => {
            for (const timer of timers) {
                clearTimeout(timer);
            }

            setLapsed(null);
        };
    }, [view, hasConnected]);

    // "Back online" stays up for a moment, then the banner clears by itself.
    useEffect(() => {
        if (!backOnline) {
            return undefined;
        }

        const timer = setTimeout(setBackOnline, CONNECTION_THRESHOLDS_MS.backOnline, false);

        return () => {
            clearTimeout(timer);
        };
    }, [backOnline]);

    // Compared against the live view, so a stage left over from a previous view never shows, even before the cleanup above has run.
    const presentation = connectionPresentationOf(view, lapsed !== null && lapsed.view === view ? lapsed.stage : "pending", {
        announced,
        backOnline,
        hasConnected,
    });

    // Only an outage the banner had shown is announced as over, and only once the socket is connected: the browser's `online`
    // event alone proves nothing reaches the backend. A socket that is not needed (`idle`) clears the banner without the claim.
    // A socket bounce the banner never showed is not announced.
    if (view === "online") {
        if (announced) {
            setAnnounced(false);
            setBackOnline(live === "connected");
        }
    } else if (backOnline) {
        setBackOnline(false);
    } else if (!announced && presentation.banner !== "online") {
        setAnnounced(true);
    }

    return presentation;
};
