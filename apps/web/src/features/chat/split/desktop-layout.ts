"use client";

import { useSyncExternalStore } from "react";

/** Below this the split is off and one chat shows (the app's `md` breakpoint). */
export const DESKTOP_QUERY = "(min-width: 768px)";

const subscribeDesktop = (notify: () => void): (() => void) => {
    const media = globalThis.matchMedia(DESKTOP_QUERY);

    media.addEventListener("change", notify);

    return () => media.removeEventListener("change", notify);
};

/** Whether the window is wide enough for the split view to lay its panes out side by side, read when it is needed. */
export const isDesktopNow = (): boolean => globalThis.matchMedia(DESKTOP_QUERY).matches;

/** Whether the split view lays its panes out side by side. Read on the server as desktop, so the first render matches. */
export const useIsDesktop = (): boolean =>
    useSyncExternalStore(
        subscribeDesktop,
        () => globalThis.matchMedia(DESKTOP_QUERY).matches,
        () => true,
    );
