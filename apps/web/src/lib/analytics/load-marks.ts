import { useEffect } from "react";

/**
 * The app's own load milestones, as `performance.mark`s. They stay on the first-load path, so this file holds only
 * the marks; `load-timing/report-load-timing.ts` reads and reports them after first paint.
 */
export const LOAD_MARKS = {
    composerVisible: "neore:composer-visible",
    sidebarListVisible: "neore:sidebar-list-visible",
} as const;

export type LoadMark = (typeof LOAD_MARKS)[keyof typeof LOAD_MARKS];

const recorded = new Set<LoadMark>();

/** Record `name` once per page load; later calls (another composer, a remount) are ignored. */
export const markLoadOnce = (name: LoadMark): void => {
    if (recorded.has(name) || typeof performance === "undefined" || typeof performance.mark !== "function") {
        return;
    }

    recorded.add(name);
    performance.mark(name);
};

/**
 * Mark `name` on the first frame after the component shows it (`ready`). The mark lands in the next animation frame,
 * which is the frame that paints the committed DOM.
 */
export const useLoadMark = (name: LoadMark, ready = true): void => {
    useEffect(() => {
        if (!ready || recorded.has(name)) {
            return undefined;
        }

        const frame = requestAnimationFrame(() => {
            markLoadOnce(name);
        });

        return () => {
            cancelAnimationFrame(frame);
        };
    }, [name, ready]);
};
