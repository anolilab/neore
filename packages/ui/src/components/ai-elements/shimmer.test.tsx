// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import Shimmer from "./shimmer";

const { motionProps, reducedMotion } = vi.hoisted(() => {
    return { motionProps: [] as { transition?: { repeat?: number } }[], reducedMotion: { value: false } };
});

// Stand-in for Motion: records the props the shimmer hands it, since that is what decides whether it loops.
// eslint-disable-next-line no-restricted-syntax -- vi.mock is hoisted; there is nothing to inject into
vi.mock("motion/react", async () => {
    const { createElement } = await import("react");

    const make = (tag: string) => (props: { children?: unknown; transition?: { repeat?: number } }) => {
        motionProps.push({ transition: props.transition });

        return createElement(tag, null, props.children as string);
    };

    return {
        motion: { div: make("div"), h1: make("h1"), h2: make("h2"), h3: make("h3"), p: make("p"), span: make("span") },
        useReducedMotion: () => reducedMotion.value,
    };
});

// React only batches updates inside `act` when this flag is set.
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const renderShimmer = () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
        root.render(<Shimmer>Thinking...</Shimmer>);
    });

    return () => {
        act(() => root.unmount());
    };
};

describe("Shimmer", () => {
    afterEach(() => {
        motionProps.length = 0;
        reducedMotion.value = false;
    });

    it("loops forever by default", () => {
        const unmount = renderShimmer();

        expect(motionProps.at(-1)?.transition?.repeat).toBe(Infinity);
        unmount();
    });

    it("renders without an infinite animation when reduced motion is set", () => {
        reducedMotion.value = true;
        const unmount = renderShimmer();

        expect(motionProps.at(-1)?.transition?.repeat).toBeUndefined();
        unmount();
    });
});
