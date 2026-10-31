import { useEffect } from "react";

import { FIND_IN_THREAD_HOST_ATTRIBUTE } from "@/features/keyboard/lib/find-in-thread-target";

import { clearHighlights, collectRanges, installHighlightStyles, setHighlights } from "./highlight";
import type { FindMatch } from "./match";

/** How long after a navigation the jump has had to scroll the message before the occurrence is checked. */
const REVEAL_DELAY_MS = 150;

const isOutside = (range: Range, viewport: Element | null): boolean => {
    const rect = range.getBoundingClientRect();
    const bounds = viewport?.getBoundingClientRect() ?? { bottom: window.innerHeight, top: 0 };

    return rect.bottom < bounds.top || rect.top > bounds.bottom;
};

interface HighlightPass {
    all: Range[];
    current: Range | undefined;
}

const collectPass = (host: Element, query: string, current: FindMatch | undefined): HighlightPass => {
    const all: Range[] = [];
    let currentRange: Range | undefined;

    for (const element of host.querySelectorAll<HTMLElement>("[data-list-message-id]")) {
        const ranges = collectRanges(element, query);

        all.push(...ranges);

        // The DOM can hold more or fewer hits than the message data (markup splits text), so the ordinal is clamped.
        if (current && element.dataset.listMessageId === current.messageId && ranges.length > 0) {
            currentRange = ranges[Math.min(current.occurrence, ranges.length - 1)];
        }
    }

    return { all, current: currentRange };
};

/**
 * Paints the find matches with the CSS Custom Highlight API: the rendered DOM is never touched.
 * The mounted rows are re-scanned when the list changes (windowed rows mount as they scroll in,
 * a streaming reply grows). Without the API nothing is painted; the bar still scrolls and counts.
 */
const useFindHighlights = (active: boolean, query: string, current: FindMatch | undefined, revealKey: number): void => {
    const currentMessageId = current?.messageId;
    const currentOccurrence = current?.occurrence;

    useEffect(() => {
        if (!active) {
            return undefined;
        }

        return installHighlightStyles();
    }, [active]);

    useEffect(() => {
        const host = document.querySelector(`[${CSS.escape(FIND_IN_THREAD_HOST_ATTRIBUTE)}]`);

        if (!active || !host) {
            return undefined;
        }

        const target = currentMessageId === undefined ? undefined : { messageId: currentMessageId, occurrence: currentOccurrence ?? 0 };
        let frame = 0;
        const apply = (): Range | undefined => {
            const pass = collectPass(host, query, target);

            setHighlights(pass.all, pass.current);

            return pass.current;
        };

        apply();

        const observer = new MutationObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(apply);
        });

        observer.observe(host, { characterData: true, childList: true, subtree: true });

        // The message jump scrolls the whole message; a long one can still hold the occurrence off screen.
        const reveal = setTimeout(() => {
            const range = apply();

            if (range && isOutside(range, host.querySelector('[data-slot="scroll-area-viewport"]'))) {
                range.startContainer.parentElement?.scrollIntoView({ block: "center" });
            }
        }, REVEAL_DELAY_MS);

        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
            clearTimeout(reveal);
            clearHighlights();
        };
    }, [active, query, currentMessageId, currentOccurrence, revealKey]);
};

export default useFindHighlights;
