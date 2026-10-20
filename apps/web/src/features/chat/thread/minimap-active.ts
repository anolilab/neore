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

            const line = window.innerHeight * READING_LINE_RATIO;
            const reached = new Set<string>();

            for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
                const id = row.dataset.listMessageId;

                if (id !== undefined && wanted.has(id) && row.getBoundingClientRect().top <= line) {
                    reached.add(id);
                }
            }

            setActive(lastReachedId(order, reached));
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

        return () => {
            if (frame !== 0) {
                cancelAnimationFrame(frame);
            }

            window.removeEventListener("scroll", schedule, { capture: true });
            window.removeEventListener("resize", schedule);
            mutations?.disconnect();
        };
    }, [key]);

    return active;
};
