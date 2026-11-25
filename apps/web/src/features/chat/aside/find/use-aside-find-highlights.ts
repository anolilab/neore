import type { RefObject } from "react";
import { useEffect } from "react";

import { ASIDE_HIGHLIGHTS, clearHighlights, collectRanges, installHighlightStyles, setHighlights } from "@/features/chat/thread/find/highlight";
import { clampIndex } from "@/features/chat/thread/find/match";
import { ASIDE_FIND_HOST_ATTRIBUTE } from "@/features/keyboard/lib/aside-find-target";

/** The attribute on each entry's row (`aside-panel.tsx`), which the matches are grouped by. */
export const ASIDE_ENTRY_ATTRIBUTE = "data-aside-entry-id";

/** A rendered answer's buttons (a code block's "show all", say) are controls, not text: a search neither counts nor paints them. */
const ASIDE_SKIPPED_PARENTS = "script, style, textarea, input, button";

/** How long after a navigation the scroll has had to settle before the occurrence is brought into view. */
const REVEAL_DELAY_MS = 150;

/** The band at the top of the scroll container that the sticky find bar covers. */
const STICKY_BAR_CLEARANCE_PX = 56;

/** Whether a hit sits outside the part of the panel the reader can see, the sticky bar's band included. */
export const isOutsideViewport = (rect: Pick<DOMRect, "bottom" | "top">, bounds: Pick<DOMRect, "bottom" | "top">): boolean =>
    rect.top < bounds.top + STICKY_BAR_CLEARANCE_PX || rect.bottom > bounds.bottom;

/**
 * Every occurrence of `query` in the panel as it is rendered, in panel order (question, then answer, entry by entry).
 * Counting the rendered text rather than the Markdown source keeps the count, the highlights and the navigation in
 * step: image alt text and formatting marks the page does not show are not counted, and a question shows literally,
 * so the text it shows is what matches.
 */
export const collectAsideRanges = (host: Element, query: string): Range[] => {
    const ranges: Range[] = [];

    for (const row of host.querySelectorAll<HTMLElement>(`[${CSS.escape(ASIDE_ENTRY_ATTRIBUTE)}]`)) {
        ranges.push(...collectRanges(row, query, ASIDE_SKIPPED_PARENTS));
    }

    return ranges;
};

/**
 * Paints the side-question matches under the side find's own highlight names, so the thread find's highlights are never
 * touched, and reports how many there are. Re-scans while answers arrive. The host is the panel section the bar sits in.
 */
const useAsideFindHighlights = (
    anchorRef: RefObject<HTMLElement | null>,
    active: boolean,
    query: string,
    index: number,
    revealKey: number,
    onCount: (count: number) => void,
): void => {
    useEffect(() => {
        if (!active) {
            return undefined;
        }

        return installHighlightStyles(ASIDE_HIGHLIGHTS);
    }, [active]);

    useEffect(() => {
        const host = anchorRef.current?.closest(`[${CSS.escape(ASIDE_FIND_HOST_ATTRIBUTE)}]`);

        if (!active || !host) {
            return undefined;
        }

        let frame = 0;
        const apply = (): Range | undefined => {
            const all = collectAsideRanges(host, query);
            const current = all.length > 0 ? all[clampIndex(index, all.length)] : undefined;

            setHighlights(all, current, ASIDE_HIGHLIGHTS);
            onCount(all.length);

            return current;
        };

        apply();

        const observer = new MutationObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(apply);
        });

        observer.observe(host, { characterData: true, childList: true, subtree: true });

        // The occurrence can sit in an answer that is still rendering, so the scroll waits for the layout to settle.
        // Scrolls only when the hit is out of sight: a keystroke or a step to a visible hit leaves the panel where it is.
        const reveal = setTimeout(() => {
            const target = apply()?.startContainer.parentElement;
            const viewport = host.closest(".overflow-y-auto") ?? document.documentElement;

            if (target && isOutsideViewport(target.getBoundingClientRect(), viewport.getBoundingClientRect())) {
                target.scrollIntoView({ block: "center" });
            }
        }, REVEAL_DELAY_MS);

        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
            clearTimeout(reveal);
            clearHighlights(ASIDE_HIGHLIGHTS);
        };
    }, [active, query, index, revealKey, onCount, anchorRef]);
};

export default useAsideFindHighlights;
