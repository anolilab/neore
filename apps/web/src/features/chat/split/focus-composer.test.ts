import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FOCUS_FRAMES, focusComposerWhenMounted } from "./focus-composer";

// The frame loop is driven by hand: each `runFrame` is one animation frame.
const frameQueue: { callbacks: FrameRequestCallback[] } = { callbacks: [] };

const runFrame = (): void => {
    const due = frameQueue.callbacks;

    frameQueue.callbacks = [];

    for (const callback of due) {
        callback(0);
    }
};

const mountPane = () => {
    const element = document.createElement("section");

    document.body.appendChild(element);

    return { current: element as HTMLElement | null, element };
};

const composer = (): HTMLTextAreaElement => {
    const editor = document.createElement("textarea");

    editor.dataset.focusArea = "composer";

    return editor;
};

beforeEach(() => {
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
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});

describe("focusComposerWhenMounted", () => {
    it("moves focus into the composer once it has mounted, and settles with true", () => {
        const pane = mountPane();
        const onSettled = vi.fn();

        focusComposerWhenMounted(pane, onSettled);

        // The composer loads after the pane is shown: nothing is focused and nothing has settled yet.
        runFrame();
        expect(onSettled).not.toHaveBeenCalled();

        const editor = composer();

        pane.element.appendChild(editor);
        runFrame();

        expect(document.activeElement).toBe(editor);
        expect(onSettled).toHaveBeenCalledTimes(1);
        expect(onSettled).toHaveBeenCalledWith(true);
    });

    it("gives up after the frame budget and settles with false, leaving focus where it was", () => {
        const pane = mountPane();
        const onSettled = vi.fn();

        focusComposerWhenMounted(pane, onSettled);

        for (let frame = 0; frame < FOCUS_FRAMES; frame += 1) {
            runFrame();
        }

        expect(onSettled).toHaveBeenCalledTimes(1);
        expect(onSettled).toHaveBeenCalledWith(false);
        expect(document.activeElement).toBe(document.body);
    });

    it("stops retrying when its cleanup runs, so a left pane does not take focus later", () => {
        const pane = mountPane();
        const onSettled = vi.fn();

        const cancel = focusComposerWhenMounted(pane, onSettled);

        cancel();
        pane.element.appendChild(composer());
        runFrame();

        expect(onSettled).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(document.body);
    });
});
