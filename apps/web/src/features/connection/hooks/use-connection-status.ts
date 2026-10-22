import { useEffect, useReducer, useState } from "react";

import { useLunora } from "@/lib/lunora/crpc";

import type { ConnectionView } from "../lib/connection-state";
import { connectionViewOf, initialConnectionState, reduceConnection } from "../lib/connection-state";

/**
 * How long a reconnect must last before it is shown. The client bounces its
 * socket whenever the bearer's subject changes (sign-in, guest conversion), and
 * a flash of "Reconnecting" for that is noise. `offline` is never delayed.
 */
export const RECONNECTING_GRACE_MS = 2000;

/** The app's connection view. Starts `online` on the server and on first paint; reads `navigator.onLine` after mount. */
export const useConnectionStatus = (): ConnectionView => {
    const client = useLunora();
    const [state, dispatch] = useReducer(reduceConnection, true, initialConnectionState);
    const [graced, setGraced] = useState(false);
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
        if (view !== "reconnecting") {
            return undefined;
        }

        const timer = setTimeout(setGraced, RECONNECTING_GRACE_MS, true);

        return () => {
            clearTimeout(timer);
            setGraced(false);
        };
    }, [view]);

    if (view !== "reconnecting") {
        return view;
    }

    return graced ? view : "online";
};
