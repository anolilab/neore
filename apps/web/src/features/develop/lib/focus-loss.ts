import type { RefObject } from "react";
import { useLayoutEffect } from "react";

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
