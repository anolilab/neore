import { useEffect, useState } from "react";

/** `value` once it has stayed the same for `delayMs`: a search box asks once per pause, not once per keystroke. */
const useDebouncedValue = <T>(value: T, delayMs: number): T => {
    const [debounced, setDebounced] = useState(value);

    useEffect(() => {
        const timer = setTimeout(setDebounced, delayMs, value);

        return () => clearTimeout(timer);
    }, [value, delayMs]);

    return debounced;
};

export default useDebouncedValue;
