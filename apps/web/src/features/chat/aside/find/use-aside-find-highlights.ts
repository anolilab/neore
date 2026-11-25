import type { RefObject } from "react";
import { useEffect } from "react";

import { ASIDE_HIGHLIGHTS, clearHighlights, collectRanges, installHighlightStyles, setHighlights } from "@/features/chat/thread/find/highlight";
import { clampIndex } from "@/features/chat/thread/find/match";
import { ASIDE_FIND_HOST_ATTRIBUTE } from "@/features/keyboard/lib/aside-find-target";

/** The attribute on each entry's row (`aside-panel.tsx`), which the matches are grouped by. */
export const ASIDE_ENTRY_ATTRIBUTE = "data-aside-entry-id";

/**
 * What a reader cannot see, so a search neither counts nor paints it: a rendered answer's buttons (a code block's "show
 * all", say), and KaTeX's MathML copy of a formula, which carries the TeX source beside the glyphs it shows.
 */
const ASIDE_SKIPPED_PARENTS = "script, style, textarea, input, button, annotation, .katex-mathml";

/** How long after a navigation the scroll has had to settle before the occurrence is brought into view. */
const REVEAL_DELAY_MS = 150;

/** The band at the top of the scroll container that the sticky find bar covers. */
const STICKY_BAR_CLEARANCE_PX = 56;

/** Whether a hit sits outside the part of the panel the reader can see, the sticky bar's band included. */
export const isOutsideViewport = (rect: Pick<DOMRect, "bottom" | "top">, bounds: Pick<DOMRect, "bottom" | "top">): boolean =>
    rect.top < bounds.top + STICKY_BAR_CLEARANCE_PX || rect.bottom > bounds.bottom;

/** Whether two current hits are the same occurrence, by where each starts in the document. */
export const isSameHit = (a: Range | undefined, b: Range | undefined): boolean => a?.startContainer === b?.startContainer && a?.startOffset === b?.startOffset;

/**
 * Where a hit sits, measured from the panel's top edge. Scrolling the panel moves the hit and the panel together, so only
 * a change in the content above the hit moves this offset. jsdom lays out no ranges, so it reports none there.
 */
const offsetWithin = (range: Range | undefined, host: Element): number | undefined =>
    typeof range?.getBoundingClientRect === "function" ? range.getBoundingClientRect().top - host.getBoundingClientRect().top : undefined;

/**
 * Every occurrence of `query` in the panel as it is rendered, in panel order (question, then answer, entry by entry).
 * Counting the rendered text rather than the Markdown source keeps the count, the highlights and the navigation in
 * step: image alt text, formatting marks and formula source the page does not show are not counted.
 */
export const collectAsideRanges = (host: Element, query: string): Range[] => {
    const ranges: Range[] = [];

    for (const row of host.querySelectorAll<HTMLElement>(`[${CSS.escape(ASIDE_ENTRY_ATTRIBUTE)}]`)) {
        ranges.push(...collectRanges(row, query, ASIDE_SKIPPED_PARENTS));
    }

    return ranges;
};

/**
 * Brings the hit into view if it is out of sight. The hit's own rectangle decides, not its block's: a long answer can
 * carry the selected hit at its far edge while the block itself is partly on screen. jsdom lays out no ranges, so it
 * falls back to the block there.
 */
const revealIfOutOfSight = (range: Range | undefined, host: Element): void => {
    const target = range?.startContainer.parentElement;
    const rect = typeof range?.getBoundingClientRect === "function" ? range.getBoundingClientRect() : target?.getBoundingClientRect();

    if (!target || !rect) {
        return;
    }

    const viewport = host.closest(".overflow-y-auto") ?? document.documentElement;

    if (isOutsideViewport(rect, viewport.getBoundingClientRect())) {
        target.scrollIntoView({ block: "center" });
    }
};

/**
 * Paints the side-question matches under the side find's own highlight names, so the thread find's highlights are never
 * touched, and reports how many there are. Re-scans while answers arrive, and reveals the current hit whenever a new
 * answer brings it into existence or moves it. The host is the panel section the bar sits in.
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
        let revealTimer: ReturnType<typeof setTimeout> | undefined;
        let applied: Range | undefined;
        let appliedOffset: number | undefined;

        const apply = (): Range | undefined => {
            const all = collectAsideRanges(host, query);
            const current = all.length > 0 ? all[clampIndex(index, all.length)] : undefined;

            setHighlights(all, current, ASIDE_HIGHLIGHTS);
            onCount(all.length);
            applied = current;
            appliedOffset = offsetWithin(current, host);

            return current;
        };

        // The occurrence can sit in an answer that is still rendering, so the reveal waits for the layout to settle.
        // It scrolls only when the hit is out of sight: a keystroke or a step to a visible hit leaves the panel where it is.
        const scheduleReveal = (): void => {
            clearTimeout(revealTimer);
            revealTimer = globalThis.setTimeout(() => {
                revealIfOutOfSight(apply(), host);
            }, REVEAL_DELAY_MS);
        };

        apply();
        scheduleReveal();

        const observer = new MutationObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const before = applied;
                const beforeOffset = appliedOffset;

                apply();

                // A new answer can bring the current hit into existence, or push it along the panel (its text unchanged):
                // either way that hit is revealed too.
                if (beforeOffset !== appliedOffset || !isSameHit(before, applied)) {
                    scheduleReveal();
                }
            });
        });

        observer.observe(host, { characterData: true, childList: true, subtree: true });

        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
            clearTimeout(revealTimer);
            clearHighlights(ASIDE_HIGHLIGHTS);
        };
    }, [active, query, index, revealKey, onCount, anchorRef]);
};

export default useAsideFindHighlights;
