import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOAD_MARKS, useLoadMarkWhenVisible } from "./load-marks";

type ObserverCallback = (entries: Partial<IntersectionObserverEntry>[]) => void;

describe(useLoadMarkWhenVisible, () => {
    afterEach(() => {
        performance.clearMarks();
    });

    it("waits for the row to be on screen, not just mounted, and marks that frame's time", () => {
        let notify: ObserverCallback = () => {};

        vi.stubGlobal(
            "IntersectionObserver",
            vi.fn(
                class {
                    public disconnect = vi.fn();

                    public observe = vi.fn();

                    public unobserve = vi.fn();

                    public constructor(callback: ObserverCallback) {
                        notify = callback;
                    }
                },
            ),
        );

        renderHook(() => {
            const ref = useRef(document.createElement("div"));

            useLoadMarkWhenVisible(LOAD_MARKS.sidebarListVisible, ref);
        });

        // Mounted in a collapsed, off-canvas sidebar.
        notify([{ isIntersecting: false, time: 100 }]);

        expect(performance.getEntriesByName(LOAD_MARKS.sidebarListVisible, "mark")).toHaveLength(0);

        // The sidebar opens.
        notify([{ isIntersecting: true, time: 2500 }]);

        expect(performance.getEntriesByName(LOAD_MARKS.sidebarListVisible, "mark")[0]?.startTime).toBe(2500);
    });
});
