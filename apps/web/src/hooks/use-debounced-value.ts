import { useEffect, useState } from "react";

/**
 * `value` once it has stayed the same for `delayMs`: a search box asks once per pause, not once per keystroke.
 *
 * A value `isImmediate` accepts (a cleared box) is taken at once and replaces the pending one, so typing again after it starts a
 * fresh pause instead of bringing back the value from before.
 */
const useDebouncedValue = <T>(value: T, delayMs: number, isImmediate?: (candidate: T) => boolean): T => {
    const [debounced, setDebounced] = useState(value);
    const immediate = isImmediate?.(value) === true;

    // Adjusted during render, not in an effect: the cleared value is there in the same render that clears the box.
    if (immediate && !Object.is(debounced, value)) {
        setDebounced(value);
    }

    useEffect(() => {
        if (immediate) {
            return undefined;
        }

        const timer = setTimeout(setDebounced, delayMs, value);

        return () => clearTimeout(timer);
    }, [value, delayMs, immediate]);

    return immediate ? value : debounced;
};

export default useDebouncedValue;
