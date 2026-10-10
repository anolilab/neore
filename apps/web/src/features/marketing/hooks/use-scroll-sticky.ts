"use client";

/**
 * useScrollSticky - Hook to detect when an element scrolls out of view
 *
 * Uses scroll events to detect when the hero composer scrolls out of view
 * within a custom scroll container.
 */

import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

interface UseScrollStickyOptions {
    /** Offset from top before triggering sticky (default: 100) */
    offset?: number;
    /** Scroll container ref - if not provided, uses window */
    scrollContainerRef?: RefObject<HTMLElement | null>;
}

interface UseScrollStickyReturn {
    isSticky: boolean;
    ref: RefObject<HTMLDivElement | null>;
}

const useScrollSticky = (options: UseScrollStickyOptions = {}): UseScrollStickyReturn => {
    const { offset = 100, scrollContainerRef } = options;
    const ref = useRef<HTMLDivElement>(null);
    const [isSticky, setIsSticky] = useState(false);

    const handleScroll = useCallback(() => {
        const element = ref.current;

        if (!element) {
            return;
        }

        const scrollContainer = scrollContainerRef?.current;
        const elementRect = element.getBoundingClientRect();

        // Element is "out of view" when its bottom is above the top of whatever
        // scrolls it, plus the offset. Without a container that top is the
        // viewport's, i.e. 0.
        const containerTop = scrollContainer ? scrollContainer.getBoundingClientRect().top : 0;

        setIsSticky(elementRect.bottom < containerTop + offset);
    }, [scrollContainerRef, offset]);

    useEffect(() => {
        // Resolved here rather than during render: on the first render the
        // container ref is still null, so a render-time read would attach the
        // listener to the window and only correct itself if some later render
        // happened to observe the populated ref.
        const target = scrollContainerRef?.current ?? globalThis;

        // Initial check
        handleScroll();

        target.addEventListener("scroll", handleScroll, { passive: true });

        return () => {
            target.removeEventListener("scroll", handleScroll);
        };
    }, [scrollContainerRef, handleScroll]);

    return { isSticky, ref };
};

export default useScrollSticky;
