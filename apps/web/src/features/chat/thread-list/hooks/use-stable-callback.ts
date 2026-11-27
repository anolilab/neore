import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A callback whose identity never changes but which always runs the latest `callback`. For handlers handed to every memoized row:
 * one whose closure changes (the open thread, the thread data) would otherwise re-render all of them. Not for use during render.
 */
const useStableCallback = <Arguments extends unknown[], Result>(callback: (...args: Arguments) => Result): ((...args: Arguments) => Result) => {
    const callbackReference = useRef(callback);

    useLayoutEffect(() => {
        callbackReference.current = callback;
    });

    return useCallback((...args: Arguments) => callbackReference.current(...args), []);
};

export default useStableCallback;
