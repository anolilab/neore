/**
 * Stick to the bottom while message rows settle. Rows off screen skip layout (`content-visibility` in styles.css) and
 * are counted at an estimated height until they render, so the content keeps growing after the thread opens. jsdom has
 * no layout: the scroller's heights and position are set by hand, and the browser's own reactions (scroll anchoring
 * moving the view, a resize being observed) are played by the test.
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ThreadViewport from "./thread-viewport";

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatIsStreaming: () => {
            return { activeStreamId: null };
        },
        useChatMessages: () => {
            return { loadMore: () => {}, messages: [{ id: "m1" }], messagesReady: true, messagesStatus: "Exhausted" };
        },
    };
});

vi.mock("./at-bottom-context", () => {
    return { useSetIsAtBottom: () => () => {} };
});

const CLIENT_HEIGHT = 800;

/** What the test plays of the browser: the scroller's geometry, and the resize observer it registered. */
const layout = { scrollHeight: 10_000, scrollTop: 0 };
const resized: (() => void)[] = [];

/** Records the callback of each observer once it observes something, so the test can play a resize. */
class RecordingResizeObserver {
    private readonly callback: () => void;

    public constructor(callback: () => void) {
        this.callback = callback;
    }

    public disconnect(): void {
        resized.splice(0, resized.length, ...resized.filter((callback) => callback !== this.callback));
    }

    public observe(): void {
        if (!resized.includes(this.callback)) {
            resized.push(this.callback);
        }
    }

    public unobserve(): void {
        this.disconnect();
    }
}

const nextFrames = async (count: number): Promise<void> => {
    for (let frame = 0; frame < count; frame += 1) {
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
        });
    }
};

const mount = async (): Promise<HTMLElement> => {
    render(
        <ThreadViewport>
            <div>content</div>
        </ThreadViewport>,
    );

    const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');

    if (!viewport) {
        throw new Error("no viewport");
    }

    Object.defineProperties(viewport, {
        clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
        scrollHeight: { configurable: true, get: () => layout.scrollHeight },
        scrollTo: {
            configurable: true,
            value: ({ top }: ScrollToOptions) => {
                layout.scrollTop = Math.min(top ?? 0, layout.scrollHeight - CLIENT_HEIGHT);
            },
        },
        scrollTop: {
            configurable: true,
            get: () => layout.scrollTop,
            set: (value: number) => {
                layout.scrollTop = value;
            },
        },
    });

    // The first scroll to the bottom runs a frame after the messages are ready.
    await act(async () => {
        await nextFrames(2);
    });

    return viewport;
};

const gap = (): number => layout.scrollHeight - layout.scrollTop - CLIENT_HEIGHT;

/** A scroll event the browser fires after it moved the view to `top`. */
const scrolledTo = (viewport: HTMLElement, top: number): void => {
    act(() => {
        layout.scrollTop = top;
        viewport.dispatchEvent(new Event("scroll"));
    });
};

describe("thread viewport while message rows settle", () => {
    beforeEach(() => {
        layout.scrollHeight = 10_000;
        layout.scrollTop = 0;
        resized.length = 0;
        vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
        // The scroll area's scrollbar waits for animations, which jsdom does not have.
        Element.prototype.getAnimations = () => [];
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("keeps the reader at the bottom when rows above them take their real height", async () => {
        const viewport = await mount();

        expect(gap()).toBe(0);

        // Rows above grow by 1400 px; scroll anchoring moves the view down by 200 px to keep the visible text still.
        layout.scrollHeight += 1400;
        scrolledTo(viewport, layout.scrollTop + 200);

        expect(gap()).toBe(0);

        // Not mistaken for the reader leaving: the next growth is followed as well.
        layout.scrollHeight += 600;
        act(() => {
            for (const callback of resized) {
                callback();
            }
        });

        expect(gap()).toBe(0);
    });

    it("closes even a small gap the content leaves at the bottom, inside the at-bottom threshold", async () => {
        const viewport = await mount();

        // 40 px: still "at the bottom" by the threshold, but the last lines would sit under the edge.
        layout.scrollHeight += 40;
        scrolledTo(viewport, layout.scrollTop);

        expect(gap()).toBe(0);
    });

    it("follows content that grows beneath the reader without a scroll event", async () => {
        await mount();

        layout.scrollHeight += 900;
        act(() => {
            for (const callback of resized) {
                callback();
            }
        });

        expect(gap()).toBe(0);
    });

    it("lets the reader scroll up, and then leaves them where they are as the content grows", async () => {
        const viewport = await mount();

        scrolledTo(viewport, layout.scrollTop - 2000);

        const readingAt = layout.scrollTop;

        layout.scrollHeight += 900;
        act(() => {
            for (const callback of resized) {
                callback();
            }
        });

        expect(layout.scrollTop).toBe(readingAt);
    });
});
