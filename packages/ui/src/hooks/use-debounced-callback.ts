import { useCallbackRef } from "@ui/hooks/use-callback-ref";
import * as React from "react";

const useDebouncedCallback = <T extends (...args: never[]) => unknown>(callback: T, delay: number) => {
    const handleCallback = useCallbackRef(callback);
    const debounceTimerRef = React.useRef(0);

    React.useEffect(() => () => clearTimeout(debounceTimerRef.current), []);

    const setValue = React.useCallback(
        (...args: Parameters<T>) => {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = setTimeout(handleCallback, delay, ...args);
        },
        [handleCallback, delay],
    );

    return setValue;
};

export default useDebouncedCallback;
