import { useSyncExternalStore } from "react";

const HOVER_QUERY = "(hover: hover)";

const subscribe = (onChange: () => void): (() => void) => {
    const query = globalThis.matchMedia?.(HOVER_QUERY);

    query?.addEventListener("change", onChange);

    return () => query?.removeEventListener("change", onChange);
};

const canHoverNow = (): boolean => globalThis.matchMedia?.(HOVER_QUERY).matches ?? true;

/**
 * Whether the primary pointer can hover, as CSS's `(hover: hover)` says. A server render assumes it can, the common case, and the
 * first client render corrects it. For state that must follow the same split as `[@media(hover:none)]` classes.
 */
const useCanHover = (): boolean => useSyncExternalStore(subscribe, canHoverNow, () => true);

export default useCanHover;
