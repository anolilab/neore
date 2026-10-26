import { useEffect, useReducer, useState } from "react";

import { useLunora } from "@/lib/lunora/crpc";

import type { ConnectionPresentation, ConnectionStage, ConnectionView } from "../lib/connection-state";
import { bannerDelayMs, connectionPresentationOf, connectionViewOf, initialConnectionState, reduceConnection, screenDelayMs } from "../lib/connection-state";

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
    const view = connectionViewOf(state);

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

        const bannerDelay = bannerDelayMs(view);
        const timers = [setTimeout(setLapsed, screenDelayMs(view), { stage: "screen", view })];

        if (bannerDelay > 0) {
            timers.push(setTimeout(setLapsed, bannerDelay, { stage: "banner", view }));
        }

        return () => {
            for (const timer of timers) {
                clearTimeout(timer);
            }

            setLapsed(null);
        };
    }, [view]);

    // Compared against the live view, so a stage left over from a previous view never shows, even before the cleanup above has run.
    return connectionPresentationOf(view, lapsed !== null && lapsed.view === view ? lapsed.stage : "pending");
};
