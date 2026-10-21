import { useEffect, useState } from "react";

/**
 * Which prompt the reader is at, for the minimap's highlight: the LAST prompt, in rail order,
 * whose row has reached the reading line. A prompt that is not in the DOM (virtualized out, or not
 * loaded yet) is not in `reached`, so it is simply not picked.
 */
export const lastReachedId = (order: ReadonlyArray<string>, reached: ReadonlySet<string>): string | undefined => {
    for (let index = order.length - 1; index >= 0; index -= 1) {
        const id = order[index];

        if (id !== undefined && reached.has(id)) {
            return id;
        }
    }

    return undefined;
};

/**
 * Rows counted as reached. Normally a row is reached once its top is above the reading line. When the
 * list is scrolled to its end, the newest prompt can sit below that line (the chat cannot scroll it up
 * there), so every row on screen counts and the last one in rail order wins.
 */
export const reachedRows = (rows: ReadonlyArray<{ id: string; top: number }>, line: number, viewportHeight: number, atEnd: boolean): Set<string> =>
    new Set(rows.filter((row) => (atEnd ? row.top < viewportHeight : row.top <= line)).map((row) => row.id));

/** Whether a scrollable element is at its end, within a pixel for rounding. */
export const isScrolledToEnd = (scroller: { clientHeight: number; scrollHeight: number; scrollTop: number }): boolean =>
    scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;

/** The element that scrolls the message list: its nearest scrollable ancestor, or the page when there is none. */
const findScroller = (list: HTMLElement | null): HTMLElement => {
    for (let node = list?.parentElement ?? null; node; node = node.parentElement) {
        const { overflowY } = getComputedStyle(node);

        if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
            return node;
        }
    }

    return document.documentElement;
};

/** Rows are tagged by the message list; the rail reads the same tag. */
const ROW_SELECTOR = "[data-list-message-id]";
const LIST_SELECTOR = ".message-list";

/**
 * The reading line sits at the middle of the viewport. A row counts as reached once its top is
 * above it, so a prompt the click handler centres is reached too.
 */
const READING_LINE_RATIO = 0.5;

/**
 * Returns the id of the prompt being read. It is measured from the rows themselves on every
 * scroll, resize and list change, rather than from observer entries, so a row that jumps past
 * the line without crossing an observed edge cannot leave a stale highlight.
 */
export const useActivePromptId = (ids: ReadonlyArray<string>): string | undefined => {
    const [active, setActive] = useState<string | undefined>(undefined);
    // A string key, so a new array with the same ids does not restart the measuring.
    const key = ids.join("\u{0}");

    useEffect(() => {
        const order = key === "" ? [] : key.split("\u{0}");
        const wanted = new Set(order);

        if (order.length === 0) {
            setActive(undefined);

            return undefined;
        }

        let frame = 0;

        const measure = () => {
            frame = 0;

            const rows: { id: string; top: number }[] = [];

            for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
                const id = row.dataset.listMessageId;

                if (id !== undefined && wanted.has(id)) {
                    rows.push({ id, top: row.getBoundingClientRect().top });
                }
            }

            const atEnd = isScrolledToEnd(findScroller(document.querySelector<HTMLElement>(LIST_SELECTOR)));

            setActive(lastReachedId(order, reachedRows(rows, window.innerHeight * READING_LINE_RATIO, window.innerHeight, atEnd)));
        };

        // At most one measure per frame: scroll events arrive far faster than the screen repaints.
        const schedule = () => {
            if (frame === 0) {
                frame = requestAnimationFrame(measure);
            }
        };

        schedule();
        // Scroll events do not bubble, so the scrolling chat container is caught in the capture phase.
        window.addEventListener("scroll", schedule, { capture: true, passive: true });
        window.addEventListener("resize", schedule);

        const list = document.querySelector(LIST_SELECTOR);
        const mutations = list ? new MutationObserver(schedule) : undefined;

        if (list && mutations) {
            mutations.observe(list, { childList: true, subtree: true });
        }

        // Images and other late content change row heights without a child-list mutation or scroll.
        const growth = list && typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : undefined;

        if (list && growth) {
            growth.observe(list);
        }

        return () => {
            if (frame !== 0) {
                cancelAnimationFrame(frame);
            }

            window.removeEventListener("scroll", schedule, { capture: true });
            window.removeEventListener("resize", schedule);
            mutations?.disconnect();
            growth?.disconnect();
        };
    }, [key]);

    return active;
};
