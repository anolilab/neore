import type { RefObject } from "react";
import { useEffect } from "react";

import { ASIDE_HIGHLIGHTS, clearHighlights, collectRanges, installHighlightStyles, setHighlights } from "@/features/chat/thread/find/highlight";
import { clampIndex } from "@/features/chat/thread/find/match";
import { ASIDE_FIND_HOST_ATTRIBUTE } from "@/features/keyboard/lib/aside-find-target";

/** The attribute on each entry's row (`aside-panel.tsx`), which the matches are grouped by. */
const ASIDE_ENTRY_ATTRIBUTE = "data-aside-entry-id";

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
const isSameHit = (a: Range | undefined, b: Range | undefined): boolean => a?.startContainer === b?.startContainer && a?.startOffset === b?.startOffset;

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

const CLIPPING_OVERFLOW = new Set(["auto", "clip", "hidden", "scroll"]);

/**
 * Whether a scroll container between the hit and the panel hides part of it. A code block or a table can scroll on its
 * own, so a hit can sit inside the panel's rectangle and still be cut off by that inner box.
 */
export const isClippedWithin = (rect: Pick<DOMRect, "bottom" | "left" | "right" | "top">, target: Element, viewport: Element): boolean => {
    for (let node: Element | null = target; node && node !== viewport; node = node.parentElement) {
        const style = getComputedStyle(node);

        if (!CLIPPING_OVERFLOW.has(style.overflowX) && !CLIPPING_OVERFLOW.has(style.overflowY)) {
            continue;
        }

        const box = node.getBoundingClientRect();

        if (rect.top < box.top || rect.bottom > box.bottom || rect.left < box.left || rect.right > box.right) {
            return true;
        }
    }

    return false;
};

/** Marks the sidebar's scroll container that holds the side-question panel (`thread-sidebar.tsx`). */
const ASIDE_SCROLL_ATTRIBUTE = "data-aside-scroll";

/** The panel's own scroll container, or undefined when the panel scrolls the window. */
const scrollerOf = (host: Element): HTMLElement | undefined => host.closest<HTMLElement>(`[${CSS.escape(ASIDE_SCROLL_ATTRIBUTE)}]`) ?? undefined;

/** The hit's own rectangle, or its block's where jsdom lays out no ranges. */
const hitRect = (range: Range | undefined, target: Element): DOMRect =>
    typeof range?.getBoundingClientRect === "function" ? range.getBoundingClientRect() : target.getBoundingClientRect();

/**
 * Scrolls each scroll box between the hit and the panel sideways until the hit lies inside it, innermost first. Scrolling a
 * wide table cell into view can leave the hit past the box's far edge, so the boxes are corrected here.
 */
export const revealSideways = (range: Range | undefined, target: Element, viewport: Element): void => {
    for (let node: Element | null = target; node && node !== viewport; node = node.parentElement) {
        if (!CLIPPING_OVERFLOW.has(getComputedStyle(node).overflowX)) {
            continue;
        }

        const box = node.getBoundingClientRect();
        const rect = hitRect(range, target);
        const left = rect.left < box.left ? rect.left - box.left : Math.max(0, rect.right - box.right);

        if (left !== 0) {
            node.scrollBy({ behavior: "instant", left });
        }
    }
};

/**
 * Brings the hit into view if it is out of sight. The hit's own rectangle decides, not its block's: a long answer can
 * carry the selected hit at its far edge while the block itself is partly on screen. jsdom lays out no ranges, so it
 * falls back to the block there.
 */
const revealIfOutOfSight = (range: Range | undefined, host: Element): void => {
    const target = range?.startContainer.parentElement;

    if (!target) {
        return;
    }

    const scroller = scrollerOf(host);
    const rect = hitRect(range, target);
    // Without a scroll container of its own, the panel is read against the visible window.
    const bounds = scroller?.getBoundingClientRect() ?? { bottom: window.innerHeight, top: 0 };

    if (!isOutsideViewport(rect, bounds) && !isClippedWithin(rect, target, scroller ?? document.documentElement)) {
        return;
    }

    // Instant, so the hit is measured where the scroll has left it.
    target.scrollIntoView({ behavior: "instant", block: "center" });

    // Centring a block taller than the panel can leave the hit past the panel's edge. Scroll the panel by what is still hidden.
    const settled = hitRect(range, target);
    const correction =
        settled.top < bounds.top + STICKY_BAR_CLEARANCE_PX ? settled.top - (bounds.top + STICKY_BAR_CLEARANCE_PX) : Math.max(0, settled.bottom - bounds.bottom);

    if (correction !== 0) {
        if (scroller) {
            scroller.scrollBy({ behavior: "instant", top: correction });
        } else {
            window.scrollBy({ behavior: "instant", top: correction });
        }
    }

    revealSideways(range, target, scroller ?? document.documentElement);
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

        // A new answer can bring the current hit into existence, or push it along the panel (its text unchanged):
        // either way that hit is revealed too.
        const recheck = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const before = applied;
                const beforeOffset = appliedOffset;

                apply();

                if (beforeOffset !== appliedOffset || !isSameHit(before, applied)) {
                    scheduleReveal();
                }
            });
        };

        const observer = new MutationObserver(recheck);

        observer.observe(host, { characterData: true, childList: true, subtree: true });
        // An image that loads changes the layout above a hit without touching the DOM. Load does not bubble, hence capture.
        host.addEventListener("load", recheck, { capture: true });

        return () => {
            observer.disconnect();
            host.removeEventListener("load", recheck, { capture: true });
            cancelAnimationFrame(frame);
            clearTimeout(revealTimer);
            clearHighlights(ASIDE_HIGHLIGHTS);
        };
    }, [active, query, index, revealKey, onCount, anchorRef]);
};

export default useAsideFindHighlights;
