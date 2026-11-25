import type { RefObject } from "react";
import { useEffect } from "react";

import { clearHighlights, collectRanges, installHighlightStyles, setHighlights } from "@/features/chat/thread/find/highlight";
import type { FindMatch } from "@/features/chat/thread/find/match";
import { ASIDE_FIND_HOST_ATTRIBUTE } from "@/features/keyboard/lib/aside-find-target";

import { ASIDE_ENTRY_ATTRIBUTE } from "./aside-find";

/** How long after a navigation the scroll has had to settle before the occurrence is brought into view. */
const REVEAL_DELAY_MS = 150;

interface HighlightPass {
    all: Range[];
    current: Range | undefined;
}

const collectPass = (host: Element, query: string, current: FindMatch | undefined): HighlightPass => {
    const all: Range[] = [];
    let currentRange: Range | undefined;

    for (const row of host.querySelectorAll<HTMLElement>(`[${CSS.escape(ASIDE_ENTRY_ATTRIBUTE)}]`)) {
        const ranges = collectRanges(row, query);

        all.push(...ranges);

        if (current && row.getAttribute(ASIDE_ENTRY_ATTRIBUTE) === current.messageId && ranges.length > 0) {
            currentRange = ranges[Math.min(current.occurrence, ranges.length - 1)];
        }
    }

    return { all, current: currentRange };
};

/**
 * Paints the side-question find matches with the CSS Custom Highlight API, the same way the thread find paints its own
 * (`thread/find/use-find-highlights.ts`). The rows are re-scanned while answers arrive. The host is the panel section
 * the bar sits in, so the highlights never reach the thread.
 */
const useAsideFindHighlights = (
    anchorRef: RefObject<HTMLElement | null>,
    active: boolean,
    query: string,
    current: FindMatch | undefined,
    revealKey: number,
): void => {
    const currentMessageId = current?.messageId;
    const currentOccurrence = current?.occurrence;

    useEffect(() => {
        if (!active) {
            return undefined;
        }

        return installHighlightStyles();
    }, [active]);

    useEffect(() => {
        const host = anchorRef.current?.closest(`[${CSS.escape(ASIDE_FIND_HOST_ATTRIBUTE)}]`);

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

        // The occurrence can sit in an answer that is still rendering, so the scroll waits for the layout to settle.
        const reveal = setTimeout(() => {
            apply()?.startContainer.parentElement?.scrollIntoView({ block: "center" });
        }, REVEAL_DELAY_MS);

        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
            clearTimeout(reveal);
            clearHighlights();
        };
    }, [active, query, currentMessageId, currentOccurrence, revealKey]);
};

export default useAsideFindHighlights;
