// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import Shimmer from "./shimmer";

// React only batches updates inside `act` when this flag is set.
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const renderShimmer = (node = <Shimmer>Thinking...</Shimmer>) => {
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
        root.render(node);
    });

    return { element: container.firstElementChild as HTMLElement, unmount: () => act(() => root.unmount()) };
};

// The animation is declared in the utility, i.e. on the shimmering element, where its inline `--shimmer-duration` is
// set. A `@theme` variable would be resolved on :root instead, and every shimmer would run at the 2s fallback.
const SHIMMER_UTILITY = /@utility animate-text-shimmer \{\s*animation: text-shimmer var\(--shimmer-duration, 2s\) steps\(30\) infinite;/u;
const THEME_SHIMMER_VARIABLE = /--animate-text-shimmer:/u;
const PAUSED_RULE = /&\[data-paused\] \{\s*animation-play-state: paused;/u;
const SHIMMER_KEYFRAMES = /@keyframes text-shimmer\s*\{\s*from\s*\{\s*background-position: 100% center;\s*\}\s*to\s*\{\s*background-position: 0% center;/u;

// The stylesheet as written: the unit-test transform turns CSS imports into empty modules.
const globalCss = readFileSync(join(import.meta.dirname, "../../global.css"), "utf8");

describe("Shimmer", () => {
    it("animates with the CSS keyframe, timed by its duration", () => {
        const { element, unmount } = renderShimmer(<Shimmer duration={1}>Thinking...</Shimmer>);

        expect(element.tagName).toBe("P");
        expect(element.textContent).toBe("Thinking...");
        expect(element.classList.contains("animate-text-shimmer")).toBe(true);
        expect(element.style.getPropertyValue("--shimmer-duration")).toBe("1s");
        expect(element.style.getPropertyValue("--spread")).toBe(`${"Thinking...".length * 2}px`);
        expect(element.getAttribute("role")).toBe("status");
        unmount();
    });

    it("renders as the element it is given", () => {
        const { element, unmount } = renderShimmer(<Shimmer as="h2">Thinking...</Shimmer>);

        expect(element.tagName).toBe("H2");
        expect(element.getAttribute("role")).toBeNull();
        unmount();
    });

    it("stops the loop under reduced motion and rests at the sweep's end", () => {
        const { element, unmount } = renderShimmer();

        expect(element.classList.contains("motion-reduce:animate-none")).toBe(true);
        expect(element.classList.contains("[background-position:0%_center]")).toBe(true);
        unmount();
    });

    it("steps the sweep instead of repainting on every frame, timed on the element itself", () => {
        expect(globalCss).toMatch(SHIMMER_UTILITY);
        expect(globalCss).not.toMatch(THEME_SHIMMER_VARIABLE);
        expect(globalCss).toMatch(SHIMMER_KEYFRAMES);
    });
});

describe("Shimmer off-screen", () => {
    const observers: { callback: IntersectionObserverCallback; disconnected: boolean; targets: Element[] }[] = [];

    class FakeIntersectionObserver {
        private readonly record: (typeof observers)[number];

        public constructor(callback: IntersectionObserverCallback) {
            this.record = { callback, disconnected: false, targets: [] };
            observers.push(this.record);
        }

        public disconnect(): void {
            this.record.disconnected = true;
        }

        public observe(target: Element): void {
            this.record.targets.push(target);
        }
    }

    const report = (isIntersecting: boolean) => {
        const [observer] = observers;

        act(() => {
            observer!.callback([{ isIntersecting } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
        });
    };

    afterEach(() => {
        observers.length = 0;
        vi.unstubAllGlobals();
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    });

    it("pauses while it is out of view and runs again when it comes back", () => {
        vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
        const { element, unmount } = renderShimmer();

        expect(observers[0]?.targets).toStrictEqual([element]);
        expect("paused" in element.dataset).toBe(false);

        report(false);

        expect("paused" in element.dataset).toBe(true);
        expect(globalCss).toMatch(PAUSED_RULE);

        report(true);

        expect("paused" in element.dataset).toBe(false);

        unmount();

        expect(observers[0]?.disconnected).toBe(true);
    });

    it("keeps running where IntersectionObserver does not exist", () => {
        vi.stubGlobal("IntersectionObserver", undefined);
        const { element, unmount } = renderShimmer();

        expect("paused" in element.dataset).toBe(false);
        expect(element.classList.contains("animate-text-shimmer")).toBe(true);
        unmount();
    });
});
