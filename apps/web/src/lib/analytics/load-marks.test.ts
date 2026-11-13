import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOAD_MARKS } from "./load-marks";

type ObserverCallback = (entries: Partial<IntersectionObserverEntry>[]) => void;

describe("useLoadMarkWhenVisible", () => {
    const observers: { disconnect: ReturnType<typeof vi.fn>; notify: ObserverCallback; observe: ReturnType<typeof vi.fn> }[] = [];

    beforeEach(() => {
        observers.length = 0;
        vi.stubGlobal(
            "IntersectionObserver",
            class {
                public disconnect = vi.fn();

                public observe = vi.fn();

                public unobserve = vi.fn();

                public constructor(callback: ObserverCallback) {
                    observers.push({ disconnect: this.disconnect, notify: callback, observe: this.observe });
                }
            },
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
        performance.clearMarks();
    });

    // Fresh module state, as on a new page: each mark is recorded once per page.
    const renderRows = async (count: number): Promise<void> => {
        const { useLoadMarkWhenVisible } = await import("./load-marks");

        for (let row = 0; row < count; row += 1) {
            renderHook(() => {
                const ref = useRef(document.createElement("div"));

                useLoadMarkWhenVisible(LOAD_MARKS.sidebarListVisible, ref);
            });
        }
    };

    it("waits for a row to be on screen, not just mounted, and marks that frame's time", async () => {
        await renderRows(1);

        // Mounted in a collapsed, off-canvas sidebar.
        observers[0]?.notify([{ isIntersecting: false, time: 100 }]);

        expect(performance.getEntriesByName(LOAD_MARKS.sidebarListVisible, "mark")).toHaveLength(0);

        // The sidebar opens.
        observers[0]?.notify([{ isIntersecting: true, time: 2500 }]);

        expect(performance.getEntriesByName(LOAD_MARKS.sidebarListVisible, "mark")[0]?.startTime).toBe(2500);
    });

    it("watches every row with one viewport observer, dropped once the mark is recorded", async () => {
        await renderRows(3);

        expect(observers).toHaveLength(1);
        expect(observers[0]?.observe).toHaveBeenCalledTimes(3);

        observers[0]?.notify([{ isIntersecting: true, time: 900 }]);

        expect(observers[0]?.disconnect).toHaveBeenCalledOnce();
    });
});
