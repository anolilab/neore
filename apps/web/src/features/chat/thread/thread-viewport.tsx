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
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

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

// Distance from the top of content at which we pre-fetch older messages.
// Large enough that messages are loaded before the user reaches them.
const LOAD_MORE_THRESHOLD = 600;

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
    const setIsAtBottom = useChatUIStore((state) => state.setIsAtBottom);
    const { loadMore, messages, messagesReady, messagesStatus } = useChatMessages();
    const { activeStreamId } = useChatIsStreaming();

    // Track scroll state
    const isAtBottomRef = useRef(true);
    const userScrolledRef = useRef(false);
    const hasInitialScrolledRef = useRef(false);

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

    // Scroll to bottom function
    const scrollToBottom = useCallback(
        (behavior: ScrollBehavior = "smooth") => {
            const viewport = viewportRef.current;

            if (!viewport) {
                return;
            }

            viewport.scrollTo({
                behavior,
                top: viewport.scrollHeight,
            });

            // Reset user scroll flag and update state
            userScrolledRef.current = false;
            isAtBottomRef.current = true;
            setIsAtBottom(true);
        },
        [setIsAtBottom],
    );

    // Handle scroll events — also drives the load-more preload trigger
    const handleScroll = useCallback(() => {
        const viewport = viewportRef.current;

        if (!viewport) {
            return;
        }

        const { scrollTop } = viewport;
        const atBottom = checkIsAtBottom();

        // If user manually scrolled away from bottom, track it
        if (!atBottom && isAtBottomRef.current) {
            userScrolledRef.current = true;
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
    }, [checkIsAtBottom, setIsAtBottom]);

    // Attach scroll listener
    useEffect(() => {
        const viewport = viewportRef.current;

        if (!viewport) {
            return undefined;
        }

        viewport.addEventListener("scroll", handleScroll, { passive: true });

        return () => viewport.removeEventListener("scroll", handleScroll);
    }, [handleScroll]);

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

        if (userScrolledRef.current) {
            return undefined;
        }

        const viewport = viewportRef.current;

        if (!viewport) {
            return undefined;
        }

        // Use MutationObserver to detect content changes during streaming
        const observer = new MutationObserver(() => {
            if (!userScrolledRef.current && isAtBottomRef.current) {
                viewport.scrollTo({
                    behavior: "instant",
                    top: viewport.scrollHeight,
                });
            }
        });

        observer.observe(viewport, {
            characterData: true,
            childList: true,
            subtree: true,
        });

        return () => observer.disconnect();
    }, [activeStreamId]);

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
