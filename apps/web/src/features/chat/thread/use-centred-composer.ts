"use client";

import { useSyncExternalStore } from "react";

/**
 * Where an empty chat centres its composer under the greeting: the app's `md` width with a fine pointer. A phone, and a tablet held
 * with a touch screen, keep it at the bottom, where the keyboard decides. The thread's classes spell the same split (`md:pointer-fine:`).
 */
const CENTRED_QUERY = "(min-width: 768px) and (pointer: fine)";

const subscribe = (notify: () => void): (() => void) => {
    const media = globalThis.matchMedia?.(CENTRED_QUERY);

    media?.addEventListener("change", notify);

    return () => media?.removeEventListener("change", notify);
};

/** Whether the layout centres an empty chat's composer. A server render says yes, the case the classes style first; the client corrects it. */
const useCentredComposer = (): boolean =>
    useSyncExternalStore(
        subscribe,
        () => globalThis.matchMedia?.(CENTRED_QUERY).matches ?? true,
        () => true,
    );

export default useCentredComposer;
