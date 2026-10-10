import * as React from "react";

type PossibleRef<T> = React.Ref<T> | undefined;

/**
 * Set a given ref to a given value
 * This utility takes care of different types of refs: callback refs and RefObject(s).
 */
const setRef = <T>(ref: PossibleRef<T>, value: T) => {
    if (typeof ref === "function") {
        return ref(value);
    }

    if (ref !== null && ref !== undefined) {
        // Aliased so the write reads as "mutate this ref object", not as a
        // reassignment of the parameter itself.
        const refObject = ref;

        refObject.current = value;
    }

    return undefined;
};

/**
 * A utility to compose multiple refs together
 * Accepts callback refs and RefObject(s).
 */
const composeRefs =
    <T>(...refs: PossibleRef<T>[]): React.RefCallback<T> =>
    (node) => {
        let hasCleanup = false;
        const cleanups = refs.map((ref) => {
            const cleanup = setRef(ref, node);

            if (!hasCleanup && typeof cleanup === "function") {
                hasCleanup = true;
            }

            return cleanup;
        });

        // React <19 will log an error to the console if a callback ref returns a
        // value. We don't use ref cleanups internally so this will only happen if a
        // user's ref callback returns a value, which we only expect if they are
        // using the cleanup functionality added in React 19.
        if (hasCleanup) {
            return () => {
                for (const [i, cleanup] of cleanups.entries()) {
                    if (typeof cleanup === "function") {
                        cleanup();
                    } else {
                        setRef(refs[i], null);
                    }
                }
            };
        }

        return undefined;
    };

/**
 * A custom hook that composes multiple refs
 * Accepts callback refs and RefObject(s).
 */
const useComposedRefs = <T>(...refs: PossibleRef<T>[]): React.RefCallback<T> =>
    // biome-ignore lint/correctness/useExhaustiveDependencies: we don't want to re-run this callback when the refs change
    React.useCallback(composeRefs(...refs), refs);

export { composeRefs, useComposedRefs };
