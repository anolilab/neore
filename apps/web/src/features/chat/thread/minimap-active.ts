import { useEffect, useState } from "react";

/**
 * Which prompt the reader is at, for the minimap's highlight: the LAST prompt, in rail order,
 * whose row has reached the reading band. A row that was never observed counts as not reached,
 * so a prompt still in the virtualized head or not loaded yet is simply not picked.
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

/** Rows are tagged by the message list; the rail reads the same tag. */
const ROW_SELECTOR = "[data-list-message-id]";
const LIST_SELECTOR = ".message-list";
/** Used when the observer cannot report the band itself: the top 40% of the viewport. */
const FALLBACK_BAND_RATIO = 0.4;

/**
 * Observes the prompt rows of the message list and returns the id of the prompt being read.
 * A row counts as reached once its top has crossed the band's bottom edge, so a prompt scrolled
 * past stays reached until the reader scrolls back above it.
 */
export const useActivePromptId = (ids: ReadonlyArray<string>): string | undefined => {
    const [active, setActive] = useState<string | undefined>(undefined);
    // A string key, so a new array with the same ids does not restart the observer.
    const key = ids.join("\u{0}");

    useEffect(() => {
        const order = key === "" ? [] : key.split("\u{0}");
        const wanted = new Set(order);

        if (order.length === 0 || typeof IntersectionObserver === "undefined") {
            setActive(undefined);

            return undefined;
        }

        const reached = new Set<string>();
        const watched = new WeakSet<Element>();

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const id = (entry.target as HTMLElement).dataset.listMessageId;

                    if (id === undefined || !wanted.has(id)) {
                        continue;
                    }

                    const band = entry.rootBounds?.bottom ?? window.innerHeight * FALLBACK_BAND_RATIO;
                    const isReached = entry.boundingClientRect.top <= band;

                    if (isReached) {
                        reached.add(id);
                    } else {
                        reached.delete(id);
                    }
                }

                setActive(lastReachedId(order, reached));
            },
            // The top 40% of the viewport is the reading band; a row below it is not reached yet.
            { rootMargin: `0px 0px -${(1 - FALLBACK_BAND_RATIO) * 100}% 0px` },
        );

        const observeRows = () => {
            for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
                const id = row.dataset.listMessageId;

                if (id !== undefined && wanted.has(id) && !watched.has(row)) {
                    watched.add(row);
                    observer.observe(row);
                }
            }
        };

        observeRows();

        // Rows mount as the reader scrolls (the head is virtualized), so watch the list for new ones.
        const list = document.querySelector(LIST_SELECTOR);
        const mutations = list ? new MutationObserver(observeRows) : undefined;

        if (list && mutations) {
            mutations.observe(list, { childList: true, subtree: true });
        }

        return () => {
            mutations?.disconnect();
            observer.disconnect();
        };
    }, [key]);

    return active;
};
