"use client";

import type { FC } from "react";
import { useEffect } from "react";

import useOpenAside from "./open-aside";

/** The event the `askAside` shortcut dispatches (`use-keyboard-shortcut-handler.ts`). */
export const ASK_ASIDE_EVENT = "askAside";

/**
 * Opens the side-question panel when the `askAside` shortcut fires. Mounted
 * once per thread view (`thread.tsx`); renders nothing.
 */
const AskAsideShortcutListener: FC = () => {
    const openAside = useOpenAside();

    useEffect(() => {
        globalThis.addEventListener(ASK_ASIDE_EVENT, openAside);

        return () => {
            globalThis.removeEventListener(ASK_ASIDE_EVENT, openAside);
        };
    }, [openAside]);

    return null;
};

export default AskAsideShortcutListener;
