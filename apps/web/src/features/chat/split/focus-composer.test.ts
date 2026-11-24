import { render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FOCUS_FRAMES, focusComposerWhenMounted, useComposerFocusRequest } from "./focus-composer";
import { requestComposerFocus, useSplitLayoutStore } from "./split-layout-store";

// Every element that takes focus, in order: asserted instead of reading `document.activeElement` directly.
const focusLog: EventTarget[] = [];
const recordFocus = (event: FocusEvent) => {
    if (event.target) {
        focusLog.push(event.target);
    }
};

// The frame loop is driven by hand: each `runFrame` is one animation frame.
const frameQueue: { callbacks: FrameRequestCallback[] } = { callbacks: [] };

const runFrame = (): void => {
    const due = frameQueue.callbacks;

    frameQueue.callbacks = [];

    for (const callback of due) {
        callback(0);
    }
};

/** A pane element, rendered with `children`: `update` re-renders it with other children (the composer mounting later). */
const mountPane = (children?: ReactNode) => {
    const pane: { current: HTMLElement | null } = { current: null };
    const attach = (element: HTMLElement | null) => {
        pane.current = element;
    };
    const view = render(createElement("section", { ref: attach }, children));

    return {
        pane,
        update: (next?: ReactNode) => {
            view.rerender(createElement("section", { ref: attach }, next));
        },
    };
};

const composer = () => createElement("textarea", { "data-focus-area": "composer" });

beforeEach(() => {
    focusLog.length = 0;
    document.addEventListener("focusin", recordFocus);
    useSplitLayoutStore.setState({ composerFocusThreadId: undefined });
    frameQueue.callbacks = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frameQueue.callbacks.push(callback);

        return frameQueue.callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
        frameQueue.callbacks = [];
    });
});

afterEach(() => {
    document.removeEventListener("focusin", recordFocus);
    vi.unstubAllGlobals();
});

describe("focusComposerWhenMounted", () => {
    it("moves focus into the composer once it has mounted, and settles with true", () => {
        const { pane, update } = mountPane();
        const onSettled = vi.fn();

        focusComposerWhenMounted(pane, onSettled);

        // The composer loads after the pane is shown: nothing is focused and nothing has settled yet.
        runFrame();
        expect(onSettled).not.toHaveBeenCalled();

        update(composer());
        runFrame();

        expect(focusLog).toEqual([screen.getByRole("textbox")]);
        expect(onSettled).toHaveBeenCalledTimes(1);
        expect(onSettled).toHaveBeenCalledWith(true);
    });

    it("gives up after the frame budget and settles with false, leaving focus where it was", () => {
        const { pane } = mountPane();
        const onSettled = vi.fn();

        focusComposerWhenMounted(pane, onSettled);

        for (let frame = 0; frame < FOCUS_FRAMES; frame += 1) {
            runFrame();
        }

        expect(onSettled).toHaveBeenCalledTimes(1);
        expect(onSettled).toHaveBeenCalledWith(false);
        expect(focusLog).toEqual([]);
    });

    it("stops retrying when its cleanup runs, so a left pane does not take focus later", () => {
        const { pane, update } = mountPane();
        const onSettled = vi.fn();

        const cancel = focusComposerWhenMounted(pane, onSettled);

        cancel();
        update(composer());
        runFrame();

        expect(onSettled).not.toHaveBeenCalled();
        expect(focusLog).toEqual([]);
    });
});

describe("useComposerFocusRequest", () => {
    it("moves focus into the requested pane's composer once it is focused, and clears the request", () => {
        const { pane } = mountPane(composer());

        requestComposerFocus("chat-a");
        renderHook(() => useComposerFocusRequest(pane, "chat-a", true));

        expect(focusLog).toEqual([screen.getByRole("textbox")]);
        expect(useSplitLayoutStore.getState().composerFocusThreadId).toBeUndefined();
    });

    it("waits until the pane is focused before it moves focus", () => {
        const { pane } = mountPane(composer());

        requestComposerFocus("chat-a");
        const { rerender } = renderHook(({ isFocused }) => useComposerFocusRequest(pane, "chat-a", isFocused), {
            initialProps: { isFocused: false },
        });

        expect(focusLog).toEqual([]);
        expect(useSplitLayoutStore.getState().composerFocusThreadId).toBe("chat-a");

        rerender({ isFocused: true });

        expect(focusLog).toEqual([screen.getByRole("textbox")]);
    });

    it("leaves another pane's request alone", () => {
        const { pane } = mountPane(composer());

        requestComposerFocus("chat-b");
        renderHook(() => useComposerFocusRequest(pane, "chat-a", true));

        expect(focusLog).toEqual([]);
        expect(useSplitLayoutStore.getState().composerFocusThreadId).toBe("chat-b");
    });

    it("clears the request when the pane is left before its composer mounts", () => {
        const { pane } = mountPane();

        requestComposerFocus("chat-a");
        const { unmount } = renderHook(() => useComposerFocusRequest(pane, "chat-a", true));

        unmount();

        expect(useSplitLayoutStore.getState().composerFocusThreadId).toBeUndefined();
    });
});
