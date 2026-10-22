import { useEffect, useState } from "react";

import type { ConnectionView } from "../lib/connection-state";
import { OFFLINE_SCREEN_AFTER_MS, RECONNECTING_SCREEN_AFTER_MS } from "../lib/offline-screen";
import { useConnectionStatus } from "./use-connection-status";

/**
 * The connection view that has lasted long enough to cover the app with the offline screen, or
 * `null`. Compared against the live view, so a value left over from a previous view never shows,
 * even before the cleanup below has run.
 */
export const useOfflineScreen = (): Exclude<ConnectionView, "online"> | null => {
    const view = useConnectionStatus();
    const [lapsedView, setLapsedView] = useState<ConnectionView | null>(null);

    useEffect(() => {
        if (view === "online") {
            return undefined;
        }

        const threshold = view === "offline" ? OFFLINE_SCREEN_AFTER_MS : RECONNECTING_SCREEN_AFTER_MS;
        const timer = setTimeout(setLapsedView, threshold, view);

        return () => {
            clearTimeout(timer);
            setLapsedView(null);
        };
    }, [view]);

    return lapsedView !== null && lapsedView === view && view !== "online" ? view : null;
};
