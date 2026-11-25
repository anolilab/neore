import type { FocusEvent, RefObject } from "react";
import { useLayoutEffect, useRef } from "react";

/**
 * Calls `onLost` when the component unmounts while one of these elements holds focus, which the browser would drop to
 * the page. The cleanup of an unmounting component runs before React removes its nodes, so focus is still where it was.
 * Only on unmount: an update never reports, so a flag set here always means the element went away. `onLost` only sets a
 * ref, so the one from the first render is enough.
 */
export const useReportFocusLoss = (onLost: () => void, ...refs: ReadonlyArray<RefObject<HTMLElement | null>>) => {
    const watched = refs;

    useLayoutEffect(
        () => () => {
            const active = document.activeElement;

            if (watched.some((ref) => ref.current?.contains(active) === true)) {
                onLost();
            }
        },
        // Unmount only, see above.
        [],
    );
};

/** Focus went nowhere: nothing holds it, so moving it takes nothing from the person. */
export const focusIsLost = (): boolean => document.activeElement === null || document.activeElement === document.body;

/**
 * Like `useReportFocusLoss`, for focus anywhere in a component's React subtree, a portal (a popover) too: spread the returned
 * `onFocus` on its outer element. React's focus events bubble through portals, so the last element that took focus inside is
 * known; `onLost` runs when the component unmounts while that element still holds focus. Only on unmount, as above.
 */
export const useReportFocusLossWithin = (onLost: () => void): { onFocus: (event: FocusEvent<HTMLElement>) => void } => {
    const lastFocused = useRef<EventTarget | null>(null);

    useLayoutEffect(
        () => () => {
            if (lastFocused.current !== null && lastFocused.current === document.activeElement) {
                onLost();
            }
        },
        // Unmount only, see above.
        [],
    );

    return {
        onFocus: (event: FocusEvent<HTMLElement>) => {
            lastFocused.current = event.target;
        },
    };
};
