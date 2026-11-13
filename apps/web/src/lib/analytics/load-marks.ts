import type { RefObject } from "react";
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

/** Record `name` once per page load, at `startTime` if given; later calls (another composer, a remount) are ignored. */
export const markLoadOnce = (name: LoadMark, startTime?: number): void => {
    if (recorded.has(name) || typeof performance === "undefined" || typeof performance.mark !== "function") {
        return;
    }

    recorded.add(name);
    performance.mark(name, startTime === undefined ? undefined : { startTime });
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

// One viewport watcher per mark, shared by every element that can record it, dropped once the mark is recorded.
const watchers = new Map<LoadMark, IntersectionObserver>();

const watcherFor = (name: LoadMark): IntersectionObserver => {
    const existing = watchers.get(name);

    if (existing) {
        return existing;
    }

    const observer = new IntersectionObserver((entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);

        if (visible) {
            markLoadOnce(name, visible.time);
            observer.disconnect();
            watchers.delete(name);
        }
    });

    watchers.set(name, observer);

    return observer;
};

/**
 * Mark `name` the first time the element in `ref` is on screen. A mounted element can still be out of view (a
 * collapsed off-canvas sidebar), so this waits for the frame where it intersects the viewport and uses that frame's time.
 */
export const useLoadMarkWhenVisible = (name: LoadMark, ref: RefObject<Element | null>): void => {
    useEffect(() => {
        const element = ref.current;

        if (!element || recorded.has(name) || typeof IntersectionObserver === "undefined") {
            return undefined;
        }

        // Best-effort, as every analytics call: a watcher that cannot be made or observe never breaks the row it marks.
        let observer: IntersectionObserver;

        try {
            observer = watcherFor(name);
            observer.observe(element);
        } catch {
            return undefined;
        }

        return () => {
            observer.unobserve(element);
        };
    }, [name, ref]);
};
