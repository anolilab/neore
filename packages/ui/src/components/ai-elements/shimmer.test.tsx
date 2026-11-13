// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

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

const SHIMMER_ANIMATION = /--animate-text-shimmer:\s*text-shimmer var\(--shimmer-duration, 2s\) steps\(30\) infinite;/u;
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

    it("steps the sweep instead of repainting on every frame", () => {
        expect(globalCss).toMatch(SHIMMER_ANIMATION);
        expect(globalCss).toMatch(SHIMMER_KEYFRAMES);
    });
});
