/* eslint-disable testing-library/no-node-access -- the test plays the browser: it sets the scroller's geometry by hand */

/**
 * Stick to the bottom while message rows settle. Rows off screen skip layout (`content-visibility` in styles.css) and
 * are counted at an estimated height until they render, so the content keeps growing after the thread opens. jsdom has
 * no layout: the scroller's heights and position are set by hand, and the browser's own reactions (scroll anchoring
 * moving the view, a resize being observed) are played by the test.
 */
import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ThreadViewportRef } from "./thread-viewport";
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

/** Animation frames the test runs by hand, so no case waits on the runner delivering real ones. */
const frames = new Map<number, FrameRequestCallback>();
const frameIds = { last: 0 };

const runFrames = (count: number): void => {
    for (let frame = 0; frame < count; frame += 1) {
        const due = [...frames.values()];

        frames.clear();
        act(() => {
            for (const callback of due) {
                callback(performance.now());
            }
        });
    }
};

/** Plays every resize the viewport observes. */
const playResize = (): void => {
    act(() => {
        for (const callback of resized) {
            callback();
        }
    });
};

/** Smooth scrolls the viewport was asked for; they move the view only when the test plays them. */
const smoothScrolls: number[] = [];

const mount = (ref?: React.RefObject<ThreadViewportRef | null>): HTMLElement => {
    render(
        <ThreadViewport ref={ref}>
            <div data-list-message-id="m1">
                <button type="button">Show output</button>
            </div>
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
            value: ({ behavior, top }: ScrollToOptions) => {
                if (behavior === "smooth") {
                    smoothScrolls.push(top ?? 0);

                    return;
                }

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
    runFrames(1);

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
        smoothScrolls.length = 0;
        frames.clear();
        vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
            frameIds.last += 1;
            frames.set(frameIds.last, callback);

            return frameIds.last;
        });
        vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
        // The scroll area's scrollbar waits for animations, which jsdom does not have; removed again after each test.
        Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        Reflect.deleteProperty(Element.prototype, "getAnimations");
    });

    it("keeps the reader at the bottom when rows above them take their real height", () => {
        const viewport = mount();

        expect(gap()).toBe(0);

        // Rows above grow by 1400 px; scroll anchoring moves the view down by 200 px to keep the visible text still.
        layout.scrollHeight += 1400;
        scrolledTo(viewport, layout.scrollTop + 200);

        expect(gap()).toBe(0);

        // Not mistaken for the reader leaving: the next growth is followed as well.
        layout.scrollHeight += 600;
        playResize();

        expect(gap()).toBe(0);
    });

    it("closes even a small gap the content leaves at the bottom, inside the at-bottom threshold", () => {
        const viewport = mount();

        // 40 px: still "at the bottom" by the threshold, but the last lines would sit under the edge.
        layout.scrollHeight += 40;
        scrolledTo(viewport, layout.scrollTop);

        expect(gap()).toBe(0);
    });

    it("follows content that grows beneath the reader without a scroll event", () => {
        mount();

        layout.scrollHeight += 900;
        playResize();

        expect(gap()).toBe(0);
    });

    it("lets the reader scroll up, and then leaves them where they are as the content grows", () => {
        const viewport = mount();

        scrolledTo(viewport, layout.scrollTop - 2000);

        const readingAt = layout.scrollTop;

        layout.scrollHeight += 900;
        playResize();

        expect(layout.scrollTop).toBe(readingAt);
    });

    it("keeps a scroll up the reader asked for when rows above grow by more in the same frame", () => {
        const viewport = mount();

        // The wheel moves the view up 100 px while rows above grow by 1400 px and scroll anchoring moves it down by
        // as much: the one scroll event sees the view 1300 px further down.
        act(() => {
            viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
        });
        layout.scrollHeight += 1400;
        scrolledTo(viewport, layout.scrollTop + 1300);

        expect(gap()).toBe(100);

        layout.scrollHeight += 600;
        playResize();

        expect(gap()).toBe(700);
    });

    it("leaves the view where a jump put it when rows resize before the jump's scroll event", () => {
        mount();

        // `scrollIntoView` moved the view up; the rows it brought on screen take their real height in the same frame,
        // and the resize is observed before the browser fires the scroll event.
        layout.scrollTop -= 3000;

        const landedAt = layout.scrollTop;

        layout.scrollHeight += 500;
        playResize();

        expect(layout.scrollTop).toBe(landedAt);
    });

    it("lets a smooth scroll to the bottom run while content grows, and closes the gap when it ends", () => {
        const ref = createRef<ThreadViewportRef>();
        const viewport = mount(ref);

        // The reader scrolled up, then presses the scroll-to-bottom button.
        scrolledTo(viewport, 2000);
        act(() => ref.current?.scrollToBottom("smooth"));

        expect(smoothScrolls).toHaveLength(1);

        // Rows the animation passes take their real height: the view is left to the animation.
        layout.scrollHeight += 900;
        playResize();

        expect(layout.scrollTop).toBe(2000);

        // The animation ends at its old target, short of the new bottom; its end closes the gap.
        act(() => {
            layout.scrollTop = 10_000 - CLIENT_HEIGHT;
            viewport.dispatchEvent(new Event("scrollend"));
        });

        expect(gap()).toBe(0);
    });

    it("lets a second smooth scroll run its course when the first one's fallback timer comes due", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        try {
            const ref = createRef<ThreadViewportRef>();
            const viewport = mount(ref);

            scrolledTo(viewport, 2000);
            act(() => ref.current?.scrollToBottom("smooth"));
            act(() => {
                vi.advanceTimersByTime(600);
            });
            // The reader taps the button again before the first scroll's timer is due.
            act(() => ref.current?.scrollToBottom("smooth"));
            act(() => {
                vi.advanceTimersByTime(500);
            });

            // The second animation still runs: growth is left to it, not pinned by the first scroll's timer.
            layout.scrollHeight += 900;
            playResize();

            expect(layout.scrollTop).toBe(2000);
        } finally {
            vi.useRealTimers();
        }
    });

    it("follows growth it skipped while a wheel turn went to an inner panel", () => {
        const viewport = mount();

        // An upward wheel turn that a nested scroller takes: the thread view does not move.
        act(() => {
            viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
        });
        layout.scrollHeight += 900;
        playResize();

        expect(gap()).toBe(900);

        // No scroll event comes; once the input expires, the growth is followed.
        runFrames(2);

        expect(gap()).toBe(0);
    });

    it("does not scroll past a block the reader opens in the last row", () => {
        const viewport = mount();

        const row = document.querySelector<HTMLElement>("[data-list-message-id]")!;
        let rowHeight = 300;

        row.getBoundingClientRect = () => ({ height: rowHeight }) as DOMRect;

        const pressedAt = layout.scrollTop;

        act(() => {
            row.querySelector("button")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        });

        // The block opens beneath the button, in two steps of its animation.
        for (const grown of [400, 1200]) {
            rowHeight += grown;
            layout.scrollHeight += grown;
            playResize();
        }

        expect(layout.scrollTop).toBe(pressedAt);

        // A press that grows nothing (copy) leaves the following on for growth elsewhere.
        scrolledTo(viewport, layout.scrollHeight - CLIENT_HEIGHT);
        act(() => {
            row.querySelector("button")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        });
        layout.scrollHeight += 200;
        playResize();

        expect(gap()).toBe(0);
    });

    it("follows the pressed row when it grows long after the press, as an image loading after Copy", () => {
        const clock = { now: 1000 };
        const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock.now);

        try {
            mount();

            const row = document.querySelector<HTMLElement>("[data-list-message-id]")!;
            let rowHeight = 300;

            row.getBoundingClientRect = () => ({ height: rowHeight }) as DOMRect;

            act(() => {
                row.querySelector("button")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
            });

            // Two seconds later an image in that row loads: nothing the reader opened.
            clock.now += 2000;
            rowHeight += 400;
            layout.scrollHeight += 400;
            playResize();

            expect(gap()).toBe(0);
        } finally {
            nowSpy.mockRestore();
        }
    });
});

it("leaves no stand-in animation API behind for the tests that follow", () => {
    expect("getAnimations" in Element.prototype).toBe(false);
});
