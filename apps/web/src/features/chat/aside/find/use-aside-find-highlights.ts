import type { RefObject } from "react";
import { useEffect, useRef } from "react";

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

type Offset = { left: number; top: number };

/**
 * Where a hit sits, measured from the panel's top and left edges. Scrolling the panel moves the hit and the panel together,
 * so only a change in the content around the hit moves this offset, across either axis. A scroll box between the hit and
 * the panel moves the hit alone, so its scroll position is added back. jsdom lays out no ranges, so it reports none there.
 */
export const offsetWithin = (range: Range | undefined, host: Element): Offset | undefined => {
    if (typeof range?.getBoundingClientRect !== "function") {
        return undefined;
    }

    const rect = range.getBoundingClientRect();
    const origin = host.getBoundingClientRect();
    let scrollLeft = 0;
    let scrollTop = 0;

    for (let node = range.startContainer.parentElement; node && node !== host; node = node.parentElement) {
        scrollLeft += node.scrollLeft;
        scrollTop += node.scrollTop;
    }

    return { left: rect.left - origin.left + scrollLeft, top: rect.top - origin.top + scrollTop };
};

const sameOffset = (a: Offset | undefined, b: Offset | undefined): boolean => a?.left === b?.left && a?.top === b?.top;

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
 * How far a span lies outside a box: negative before its start, positive past its end, zero when it fits.
 */
const shiftToFit = (start: number, end: number, boxStart: number, boxEnd: number): number => (start < boxStart ? start - boxStart : Math.max(0, end - boxEnd));

/**
 * Scrolls each scroll box between the hit and the panel until the hit lies inside it, innermost first, along whichever axis
 * the box clips. Scrolling a block into view can leave the hit past a wide table cell's far edge, or inside a capped code
 * block's own vertical scroll, so each box is corrected here.
 */
export const revealWithinBoxes = (range: Range | undefined, target: Element, viewport: Element): void => {
    for (let node: Element | null = target; node && node !== viewport; node = node.parentElement) {
        const style = getComputedStyle(node);
        const clipsX = CLIPPING_OVERFLOW.has(style.overflowX);
        const clipsY = CLIPPING_OVERFLOW.has(style.overflowY);

        if (!clipsX && !clipsY) {
            continue;
        }

        const box = node.getBoundingClientRect();
        const rect = hitRect(range, target);
        const left = clipsX ? shiftToFit(rect.left, rect.right, box.left, box.right) : 0;
        const top = clipsY ? shiftToFit(rect.top, rect.bottom, box.top, box.bottom) : 0;

        if (left !== 0 || top !== 0) {
            node.scrollBy({ behavior: "instant", left, top });
        }
    }
};

/**
 * Scrolls the panel by what still hides the hit: below the sticky bar's band, past the panel's bottom, or past either side.
 */
const keepInPanel = (
    range: Range | undefined,
    target: Element,
    bounds: Pick<DOMRect, "bottom" | "left" | "right" | "top">,
    scroller: HTMLElement | undefined,
): void => {
    const settled = hitRect(range, target);
    const shiftY =
        settled.top < bounds.top + STICKY_BAR_CLEARANCE_PX ? settled.top - (bounds.top + STICKY_BAR_CLEARANCE_PX) : Math.max(0, settled.bottom - bounds.bottom);
    const shiftX = shiftToFit(settled.left, settled.right, bounds.left, bounds.right);

    if (shiftX === 0 && shiftY === 0) {
        return;
    }

    if (scroller) {
        scroller.scrollBy({ behavior: "instant", left: shiftX, top: shiftY });
    } else {
        window.scrollBy({ behavior: "instant", left: shiftX, top: shiftY });
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
    const bounds = scroller?.getBoundingClientRect() ?? { bottom: window.innerHeight, left: 0, right: window.innerWidth, top: 0 };
    // A token too wide for the panel runs past its right edge, which the vertical check alone does not see.
    const beyondSides = rect.left < bounds.left || rect.right > bounds.right;

    if (!beyondSides && !isOutsideViewport(rect, bounds) && !isClippedWithin(rect, target, scroller ?? document.documentElement)) {
        return;
    }

    // Instant, so the hit is measured where the scroll has left it.
    target.scrollIntoView({ behavior: "instant", block: "center" });

    // Centring can leave the hit past the panel's edges: scroll the panel by what is still hidden, on both axes.
    keepInPanel(range, target, bounds, scroller);

    revealWithinBoxes(range, target, scroller ?? document.documentElement);
    // A scroll box can move the hit under the sticky bar or past the panel's edge, so the panel is checked once more.
    keepInPanel(range, target, bounds, scroller);
};

/** The entry a hit's row belongs to. */
const entryOf = (range: Range | undefined): string | undefined =>
    range?.startContainer.parentElement?.closest<HTMLElement>(`[${CSS.escape(ASIDE_ENTRY_ATTRIBUTE)}]`)?.dataset.asideEntryId;

/**
 * Which hit a selection is: its entry, and its place among that entry's hits. A flat index names another hit once an
 * earlier entry gains or loses one, so the selection is kept as this and followed through each rescan.
 */
interface Anchor {
    entryId: string | undefined;
    occurrence: number;
    /** Characters from the start of the entry's text to the hit: the hit keeps it while the text around it is rewritten. */
    textOffset: number | undefined;
}

/** How far into its entry's text a hit starts, or undefined when it is not in an entry. */
const textOffsetOf = (range: Range | undefined): number | undefined => {
    const row = range?.startContainer.parentElement?.closest<HTMLElement>(`[${CSS.escape(ASIDE_ENTRY_ATTRIBUTE)}]`);

    if (!range || !row) {
        return undefined;
    }

    const lead = document.createRange();

    lead.setStart(row, 0);
    lead.setEnd(range.startContainer, range.startOffset);

    return lead.toString().length;
};

/** The selected hit: its anchor, the flat position it last held, and the navigation that selected it. */
interface Selection {
    anchor: Anchor | undefined;
    navigation: string;
    position: number;
}

const anchorAt = (all: Range[], position: number): Anchor => {
    const entryId = entryOf(all[position]);

    return {
        entryId,
        occurrence: all.slice(0, position).filter((range) => entryOf(range) === entryId).length,
        textOffset: textOffsetOf(all[position]),
    };
};

/** Whether two selections name the same hit: the same entry, and the same place in its text. */
const isSameAnchor = (a: Anchor | undefined, b: Anchor | undefined): boolean => a?.entryId === b?.entryId && a?.textOffset === b?.textOffset;

/** Where the anchored hit sits in the rescanned list, or undefined when its entry is gone. */
const positionOf = (all: Range[], anchor: Anchor): number | undefined => {
    const positions = all.flatMap((range, position) => (entryOf(range) === anchor.entryId ? [position] : []));

    if (positions.length === 0) {
        return undefined;
    }

    // The hit that still starts at the same place in its entry. When the text before it changed, the occurrence it was.
    const exact = positions.find((position) => textOffsetOf(all[position]) === anchor.textOffset);

    return exact ?? positions[Math.min(anchor.occurrence, positions.length - 1)];
};

/**
 * Paints the side-question matches under the side find's own highlight names, so the thread find's highlights are never
 * touched, and reports how many there are and where the selection sits among them. Re-scans while answers arrive, and
 * reveals the current hit whenever a new answer brings it into existence or moves it. The host is the panel section the
 * bar sits in.
 */
const useAsideFindHighlights = (
    anchorRef: RefObject<HTMLElement | null>,
    active: boolean,
    query: string,
    index: number,
    revealKey: number,
    onMatches: (count: number, position: number) => void,
): void => {
    // Kept across effect re-runs, so reopening the bar or re-showing the Ask tab leaves the selection where the reader had it.
    const selection = useRef<Selection>({ anchor: undefined, navigation: "", position: 0 });

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
        let appliedOffset: Offset | undefined;

        // A new query or a step selects the hit at `index` afresh. Any other re-run keeps the hit the reader was on.
        const navigation = JSON.stringify([query, index, revealKey]);

        if (selection.current.navigation !== navigation) {
            selection.current = { anchor: undefined, navigation, position: index };
        }

        const apply = (): Range | undefined => {
            const all = collectAsideRanges(host, query);
            const state = selection.current;
            // The hit is followed through the rescan. Once its entry is gone, the selection takes the hit now at the position it last held.
            const followed = state.anchor === undefined ? undefined : positionOf(all, state.anchor);
            const position = all.length > 0 ? (followed ?? clampIndex(state.position, all.length)) : undefined;
            const current = position === undefined ? undefined : all[position];

            if (position !== undefined) {
                state.position = position;
                state.anchor = anchorAt(all, position);
            }

            setHighlights(all, current, ASIDE_HIGHLIGHTS);
            onMatches(all.length, position ?? 0);
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
                const beforeAnchor = selection.current.anchor;

                apply();

                // Reveal a hit that came into existence, or the same hit moving along the panel. A different occurrence, which
                // only happens once the selected entry is gone, was not moved by the reader, so it is highlighted without a scroll.
                // The anchor decides which hit it is: a streamed answer can replace the text node a hit sits in, and that is still the hit.
                const sameHit = before !== undefined && applied !== undefined && isSameAnchor(beforeAnchor, selection.current.anchor);
                const appeared = before === undefined && applied !== undefined;
                const moved = sameHit && !sameOffset(beforeOffset, appliedOffset);

                if (appeared || moved) {
                    scheduleReveal();
                } else if (!sameHit) {
                    // The selected hit was replaced, so a reveal still pending for the old one must not scroll to the replacement.
                    clearTimeout(revealTimer);
                }
            });
        };

        const observer = new MutationObserver(() => {
            // The rescan runs a frame later. A reveal still pending for a dismissed entry must not fire before it, or it would
            // scroll to the hit that takes the entry's place.
            const entryId = selection.current.anchor?.entryId;

            if (entryId !== undefined && !host.querySelector(`[${CSS.escape(ASIDE_ENTRY_ATTRIBUTE)}="${CSS.escape(entryId)}"]`)) {
                clearTimeout(revealTimer);
            }

            recheck();
        });

        observer.observe(host, { characterData: true, childList: true, subtree: true });
        // An image that loads changes the layout above a hit without touching the DOM. Load does not bubble, hence capture.
        host.addEventListener("load", recheck, { capture: true });

        // A resize can clip the hit without touching the DOM, so the hit is checked once it settles. Only the scroll box's own
        // size is watched: the panel grows with each streamed token, and that growth must not pull the reader back to the hit.
        // Without a scroll box, the window's resize stands in for it.
        const scroller = scrollerOf(host);
        const resizer = scroller
            ? new ResizeObserver(() => {
                  scheduleReveal();
              })
            : undefined;

        if (scroller) {
            resizer?.observe(scroller);
        } else {
            globalThis.addEventListener("resize", scheduleReveal);
        }

        return () => {
            observer.disconnect();
            host.removeEventListener("load", recheck, { capture: true });
            resizer?.disconnect();
            globalThis.removeEventListener("resize", scheduleReveal);
            cancelAnimationFrame(frame);
            clearTimeout(revealTimer);
            clearHighlights(ASIDE_HIGHLIGHTS);
        };
    }, [active, query, index, revealKey, onMatches, anchorRef]);
};

export default useAsideFindHighlights;
