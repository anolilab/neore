import { useEffect } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { focusNextArea, trackFocusedArea } from "../lib/focus-areas";

const FOCUS_AREA_OPTIONS = {
    // F6 must reach the composer and the other fields: it is not a character key.
    enableOnContentEditable: true,
    enableOnFormTags: true,
} as const;

/**
 * F6 and Shift+F6 move focus between the screen's areas (`lib/focus-areas.ts`). Fixed keys, not rebindable. The key is
 * taken over only when focus moved: with no area to go to, the browser keeps its own F6 (its address bar).
 */
export const useFocusAreaHotkeys = (): void => {
    useEffect(() => {
        document.addEventListener("focusin", trackFocusedArea);

        return () => document.removeEventListener("focusin", trackFocusedArea);
    }, []);

    useHotkeys(
        "f6",
        (event) => {
            if (focusNextArea(1)) {
                event.preventDefault();
            }
        },
        { ...FOCUS_AREA_OPTIONS, description: "Move focus to the next area" },
        [],
    );
    useHotkeys(
        "shift+f6",
        (event) => {
            if (focusNextArea(-1)) {
                event.preventDefault();
            }
        },
        { ...FOCUS_AREA_OPTIONS, description: "Move focus to the previous area" },
        [],
    );
};
