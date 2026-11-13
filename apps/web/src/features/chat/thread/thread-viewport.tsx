"use client";

/**
 * ThreadViewport - Auto-scrolling container for chat messages
 *
 * Uses ScrollArea with custom stick-to-bottom logic for automatic scroll management.
 * Syncs scroll state with Zustand store for external components.
 * Handles initial scroll on thread load.
 *
 * Load-more is triggered from the scroll handler (not IntersectionObserver) so that
 * scrollHeight can be captured synchronously — before any React state changes happen.
 * This is the only reliable way to anchor scroll position after a prepend.
 */

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import cn from "@neore/ui/utils/cn";
import type { ReactNode } from "react";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";

import { useChatIsStreaming, useChatMessages } from "@/features/chat/core/context/chat-context";

import { useSetIsAtBottom } from "./at-bottom-context";

interface ThreadViewportProps {
    children: ReactNode;
    className?: string;
}

export interface ThreadViewportRef {
    getViewport: () => HTMLDivElement | null;
    scrollToBottom: (behavior?: ScrollBehavior) => void;
}

// Threshold in pixels to consider "at bottom"
const SCROLL_THRESHOLD = 50;

/** How long a smooth scroll to the bottom may run before growth is followed again, where `scrollend` does not fire. */
const SMOOTH_SCROLL_TIMEOUT_MS = 1000;

// Distance from the top of content at which we pre-fetch older messages.
// Large enough that messages are loaded before the user reaches them.
const LOAD_MORE_THRESHOLD = 600;

/** Keys that scroll the view up when nothing else takes them. */
const UPWARD_KEYS = new Set(["ArrowUp", "Home", "PageUp"]);

const isEditable = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));

/** Whether a key press asks the view to scroll up. */
const isUpwardKey = (event: KeyboardEvent): boolean =>
    !event.defaultPrevented && !isEditable(event.target) && (UPWARD_KEYS.has(event.key) || (event.key === " " && event.shiftKey));

/**
 * Custom ScrollBar component.
 */
const ScrollBar = ({ className, orientation = "vertical", ...props }: ScrollAreaPrimitive.Scrollbar.Props) => (
    <ScrollAreaPrimitive.Scrollbar
        className={cn(
            "m-1 flex opacity-0 transition-opacity delay-300",
            "data-hovering:opacity-100 data-hovering:delay-0 data-hovering:duration-100",
            "data-scrolling:opacity-100 data-scrolling:delay-0 data-scrolling:duration-100",
            "data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:flex-col",
            "data-[orientation=vertical]:w-1.5",
            className,
        )}
        data-slot="scroll-area-scrollbar"
        orientation={orientation}
        {...props}
    >
        <ScrollAreaPrimitive.Thumb className="bg-foreground/20 relative flex-1 rounded-full" data-slot="scroll-area-thumb" />
    </ScrollAreaPrimitive.Scrollbar>
);

/**
 * Main ThreadViewport component
 * Wraps content with ScrollArea and custom stick-to-bottom logic.
 */
const ThreadViewport = ({ children, className, ref }: ThreadViewportProps & { ref?: React.RefObject<ThreadViewportRef | null> }) => {
    const viewportRef = useRef<HTMLDivElement>(null);
    const setIsAtBottom = useSetIsAtBottom();
    const { loadMore, messages, messagesReady, messagesStatus } = useChatMessages();
    const { activeStreamId } = useChatIsStreaming();

    // Track scroll state
    const isAtBottomRef = useRef(true);
    const userScrolledRef = useRef(false);
    const hasInitialScrolledRef = useRef(false);
    // Where the last scroll event left the view, and whether a smooth scroll to the bottom is on its way there.
    const lastScrollTopRef = useRef(0);
    const smoothToBottomRef = useRef(false);
    // Ends the smooth scroll to the bottom under way: its `scrollend` listener and fallback timer.
    const endSmoothScrollRef = useRef<(() => void) | null>(null);
    // The reader asked to scroll up (wheel, key, touch) and that scroll's event has not come yet. Content growing in the
    // same frame can move the view down by more than they scrolled up, so the position alone would not show it.
    const upwardInputRef = useRef(false);
    // The row the reader last pressed in (a click, a key) and its height then. That row growing afterwards is the reader
    // opening something in it (tool output, reasoning, a long code block): the view stays where they pressed.
    const pressedRowRef = useRef<{ height: number; row: Element } | null>(null);

    // Scroll anchor: scrollHeight captured synchronously in the scroll handler at the
    // exact moment loadMore() is called — before any React state changes. This is the
    // only reliable way to measure the pre-prepend content height.
    const anchorHeightRef = useRef<number | null>(null);
    const loadMoreTriggeredRef = useRef(false);

    // Keep stable refs so the scroll handler (useCallback) doesn't need to re-attach on every render.
    const messagesStatusRef = useRef(messagesStatus);
    const loadMoreRef = useRef(loadMore);

    // Update refs after render so the scroll handler always sees the latest values without
    // causing React Compiler to flag render-time ref mutations.
    useLayoutEffect(() => {
        messagesStatusRef.current = messagesStatus;
        loadMoreRef.current = loadMore;
    });

    // Check if viewport is at bottom
    const checkIsAtBottom = useCallback(() => {
        const viewport = viewportRef.current;

        if (!viewport) {
            return true;
        }

        const { clientHeight, scrollHeight, scrollTop } = viewport;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

        return distanceFromBottom <= SCROLL_THRESHOLD;
    }, []);

    // Puts the view at the bottom at once and records where it left it, so the next scroll event can tell the reader
    // scrolling up from the content growing (a programmatic scroll's own event may come after another change).
    const pinToBottom = useCallback((viewport: HTMLElement) => {
        viewport.scrollTo({ behavior: "instant", top: viewport.scrollHeight });
        lastScrollTopRef.current = viewport.scrollTop;
    }, []);

    // Scroll to bottom function
    const scrollToBottom = useCallback(
        (behavior: ScrollBehavior = "smooth") => {
            const viewport = viewportRef.current;

            if (!viewport) {
                return;
            }

            // A newer scroll replaces the one under way: its listener and timer must not settle this one.
            endSmoothScrollRef.current?.();
            smoothToBottomRef.current = behavior === "smooth";

            if (behavior === "smooth") {
                // Growth is not followed while the animation runs (`followGrowth`). If it ends short of the bottom (the
                // content grew past its target), its end closes the gap; a timer stands in where `scrollend` never fires.
                const listening = new AbortController();
                let timer: ReturnType<typeof setTimeout> | undefined;
                const end = () => {
                    listening.abort();
                    globalThis.clearTimeout(timer);

                    if (endSmoothScrollRef.current === end) {
                        endSmoothScrollRef.current = null;
                    }
                };
                const settled = () => {
                    end();

                    if (!smoothToBottomRef.current) {
                        return;
                    }

                    smoothToBottomRef.current = false;

                    if (isAtBottomRef.current && !userScrolledRef.current && !upwardInputRef.current) {
                        pinToBottom(viewport);
                    }
                };

                endSmoothScrollRef.current = end;
                viewport.addEventListener("scrollend", settled, { signal: listening.signal });
                timer = globalThis.setTimeout(settled, SMOOTH_SCROLL_TIMEOUT_MS);
                viewport.scrollTo({ behavior, top: viewport.scrollHeight });
            } else {
                pinToBottom(viewport);
            }

            // Reset user scroll flag and update state
            userScrolledRef.current = false;
            isAtBottomRef.current = true;
            setIsAtBottom(true);
        },
        [pinToBottom, setIsAtBottom],
    );

    useEffect(() => () => endSmoothScrollRef.current?.(), []);

    // Handle scroll events — also drives the load-more preload trigger
    const handleScroll = useCallback(() => {
        const viewport = viewportRef.current;

        if (!viewport) {
            return;
        }

        const { scrollTop } = viewport;
        const atBottom = checkIsAtBottom();
        const scrolledUp = scrollTop < lastScrollTopRef.current || upwardInputRef.current;

        lastScrollTopRef.current = scrollTop;
        upwardInputRef.current = false;

        if (atBottom) {
            smoothToBottomRef.current = false;
        }

        // Off the bottom while the reader was there. Only scrolling UP is the reader leaving. A view that moved
        // down or stayed put means the content grew: rows above took their real height in place of their estimate
        // (`content-visibility`) and the browser kept the visible text still. The reader stays at the bottom then.
        if (isAtBottomRef.current && !userScrolledRef.current) {
            if (scrolledUp) {
                if (!atBottom) {
                    userScrolledRef.current = true;
                }
            } else if (!smoothToBottomRef.current && viewport.scrollHeight - scrollTop - viewport.clientHeight > 1) {
                // Close even a gap inside the threshold: the reader is at the very bottom, not near it.
                pinToBottom(viewport);

                return;
            }
        }

        // If user scrolled back to bottom, reset the flag
        if (atBottom && userScrolledRef.current) {
            userScrolledRef.current = false;
        }

        isAtBottomRef.current = atBottom;
        setIsAtBottom(atBottom);

        // Pre-fetch older messages when within LOAD_MORE_THRESHOLD of the top.
        // Capture scrollHeight HERE — synchronously, before loadMore() changes any state.
        // This is the only reliable timing to get the pre-prepend content height.
        if (scrollTop < LOAD_MORE_THRESHOLD && messagesStatusRef.current === "CanLoadMore" && !loadMoreTriggeredRef.current) {
            loadMoreTriggeredRef.current = true;
            anchorHeightRef.current = viewport.scrollHeight;
            loadMoreRef.current(20);
        }

        // Reset the trigger once the user scrolls back down far enough
        if (scrollTop > LOAD_MORE_THRESHOLD && loadMoreTriggeredRef.current && messagesStatusRef.current !== "LoadingMore") {
            loadMoreTriggeredRef.current = false;
        }
    }, [checkIsAtBottom, pinToBottom, setIsAtBottom]);

    // Follows content that grew while the reader is at the bottom: a stream, rows settling, an image loading. Not when the
    // view moved up since the last scroll event (a jump's `scrollIntoView`, the reader), the reader is about to scroll up, or
    // a smooth scroll to the bottom is running:
    // that scroll's own event decides. Not when the growth is the row the reader pressed in: they opened something there.
    const followGrowth = useCallback(
        (viewport: HTMLElement) => {
            // A smooth scroll to the bottom is under way: pinning now would cut it short with a jump. Its last scroll
            // event closes what gap the growth left (`handleScroll`).
            if (!hasInitialScrolledRef.current || userScrolledRef.current || !isAtBottomRef.current || upwardInputRef.current || smoothToBottomRef.current) {
                return;
            }

            if (viewport.scrollTop < lastScrollTopRef.current - 1 && !checkIsAtBottom()) {
                userScrolledRef.current = true;
                isAtBottomRef.current = false;

                return;
            }

            const pressed = pressedRowRef.current;
            const pressedHeight = pressed?.row.isConnected ? pressed.row.getBoundingClientRect().height : 0;

            if (pressed && pressedHeight > pressed.height + 1) {
                pressed.height = pressedHeight;

                const atBottom = checkIsAtBottom();

                isAtBottomRef.current = atBottom;
                setIsAtBottom(atBottom);

                return;
            }

            pinToBottom(viewport);
        },
        [checkIsAtBottom, pinToBottom, setIsAtBottom],
    );

    // Attach scroll listener, and the reader's input that scrolls the view or opens something in a row
    useEffect(() => {
        const viewport = viewportRef.current;

        if (!viewport) {
            return undefined;
        }

        let touchY = 0;
        let clearFrame = 0;
        const markUpward = () => {
            if (viewport.scrollTop <= 0) {
                return;
            }

            const markedAt = viewport.scrollTop;

            upwardInputRef.current = true;
            // Its scroll event comes on the next frame; an input that scrolled nothing (a nested scroller took it) expires.
            // Growth skipped meanwhile is followed then, as no scroll event will come to close the gap.
            cancelAnimationFrame(clearFrame);
            clearFrame = requestAnimationFrame(() => {
                clearFrame = requestAnimationFrame(() => {
                    upwardInputRef.current = false;

                    if (viewport.scrollTop === markedAt) {
                        followGrowth(viewport);
                    }
                });
            });
        };
        const press = (event: Event) => {
            const row = event.target instanceof Element ? event.target.closest("[data-list-message-id]") : null;

            pressedRowRef.current = row ? { height: row.getBoundingClientRect().height, row } : null;
        };
        const handleWheel = (event: WheelEvent) => {
            if (event.deltaY < 0) {
                markUpward();
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            press(event);

            if (isUpwardKey(event)) {
                markUpward();
            }
        };
        const handleTouchStart = (event: TouchEvent) => {
            touchY = event.touches[0]?.clientY ?? 0;
        };
        const handleTouchMove = (event: TouchEvent) => {
            const y = event.touches[0]?.clientY ?? touchY;

            // A finger moving down drags the content down: the view scrolls up.
            if (y > touchY) {
                markUpward();
            }

            touchY = y;
        };

        viewport.addEventListener("scroll", handleScroll, { passive: true });
        viewport.addEventListener("wheel", handleWheel, { passive: true });
        viewport.addEventListener("keydown", handleKeyDown);
        viewport.addEventListener("pointerdown", press, { capture: true, passive: true });
        viewport.addEventListener("touchstart", handleTouchStart, { passive: true });
        viewport.addEventListener("touchmove", handleTouchMove, { passive: true });

        return () => {
            cancelAnimationFrame(clearFrame);
            viewport.removeEventListener("scroll", handleScroll);
            viewport.removeEventListener("wheel", handleWheel);
            viewport.removeEventListener("keydown", handleKeyDown);
            viewport.removeEventListener("pointerdown", press, { capture: true });
            viewport.removeEventListener("touchstart", handleTouchStart);
            viewport.removeEventListener("touchmove", handleTouchMove);
        };
    }, [followGrowth, handleScroll]);

    // Initial scroll to bottom when messages become ready
    useEffect(() => {
        if (messagesReady && messages.length > 0 && !hasInitialScrolledRef.current) {
            hasInitialScrolledRef.current = true;
            // Small delay to ensure content is rendered
            requestAnimationFrame(() => {
                scrollToBottom("instant");
            });
        }

        // Reset on thread change
        if (!messagesReady) {
            hasInitialScrolledRef.current = false;
            userScrolledRef.current = false;
            pressedRowRef.current = null;
            loadMoreTriggeredRef.current = false;
            anchorHeightRef.current = null;
        }
    }, [messagesReady, messages.length, scrollToBottom]);

    // Restore scroll position after older messages are prepended.
    // anchorHeightRef was captured synchronously in the scroll handler before loadMore() was called,
    // so it always reflects the true pre-prepend scrollHeight — no batching or timing issues.
    //
    // Exception: if the user scrolled all the way to scrollTop=0 before messages arrived
    // (fast scroll), skip the correction and let them stay at the top — they clearly want
    // to read the newly loaded older messages from the beginning.
    useLayoutEffect(() => {
        const viewport = viewportRef.current;

        if (!viewport || anchorHeightRef.current === null) {
            return;
        }

        if (viewport.scrollTop > 0) {
            const heightDiff = viewport.scrollHeight - anchorHeightRef.current;

            if (heightDiff > 0) {
                viewport.scrollTop += heightDiff;
            }
        }

        anchorHeightRef.current = null;
        // Allow re-triggering once this load cycle is complete
        loadMoreTriggeredRef.current = false;
        // Re-run when message count changes (new messages arrived after loadMore).
    }, [messages.length]);

    // Auto-scroll during streaming (stick to bottom behavior)
    useLayoutEffect(() => {
        // Only auto-scroll if we're streaming and user hasn't scrolled away
        if (!activeStreamId) {
            return undefined;
        }

        const viewport = viewportRef.current;

        if (!viewport) {
            return undefined;
        }

        // Use MutationObserver to detect content changes during streaming
        const observer = new MutationObserver(() => followGrowth(viewport));

        observer.observe(viewport, {
            characterData: true,
            childList: true,
            subtree: true,
        });

        return () => observer.disconnect();
    }, [activeStreamId, followGrowth]);

    // Stick to the bottom while the reader is there and the content changes height, streaming or not: the first page
    // settling, a row near the bottom taking its real height in place of its estimate (message rows skip layout off
    // screen, `content-visibility` in styles.css), an image loading. A resize is not a DOM mutation, so the streaming
    // observer above does not see it.
    useEffect(() => {
        const viewport = viewportRef.current;

        if (!viewport || typeof ResizeObserver === "undefined") {
            return undefined;
        }

        const resizes = new ResizeObserver(() => followGrowth(viewport));
        const observeChildren = () => {
            for (const child of viewport.children) {
                resizes.observe(child);
            }
        };
        // The viewport has no single content element: its children come and go (the breadcrumb, the empty state).
        const childList = new MutationObserver(observeChildren);

        observeChildren();
        childList.observe(viewport, { childList: true });

        return () => {
            childList.disconnect();
            resizes.disconnect();
        };
    }, [followGrowth]);

    // Expose ref methods
    useImperativeHandle(ref, () => {
        return {
            getViewport: () => viewportRef.current,
            scrollToBottom,
        };
    }, [scrollToBottom]);

    return (
        <ScrollAreaPrimitive.Root className="relative h-full min-h-0 overflow-hidden">
            <ScrollAreaPrimitive.Viewport
                className={cn(
                    "flex h-full flex-col overscroll-contain",
                    "focus-visible:ring-ring focus-visible:ring-offset-background rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
                    className,
                )}
                data-focus-target=""
                data-slot="scroll-area-viewport"
                ref={viewportRef}
            >
                {children}
            </ScrollAreaPrimitive.Viewport>
            <ScrollBar orientation="vertical" />
            <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
        </ScrollAreaPrimitive.Root>
    );
};

ThreadViewport.displayName = "ThreadViewport";

export default ThreadViewport;
