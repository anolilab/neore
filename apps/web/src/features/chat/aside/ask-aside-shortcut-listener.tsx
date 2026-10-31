"use client";

import type { FC } from "react";
import { useEffect } from "react";

import { useChatThread } from "@/features/chat/core/context/chat-context";

import useOpenAside from "./open-aside";

/** The event the `askAside` shortcut dispatches (`use-keyboard-shortcut-handler.ts`). */
export const ASK_ASIDE_EVENT = "askAside";

/**
 * Opens the side-question panel when the `askAside` shortcut fires. Mounted
 * once per thread view (`thread.tsx`); renders nothing.
 */
const AskAsideShortcutListener: FC = () => {
    const openAside = useOpenAside();
    const { thread } = useChatThread();
    // The tab only exists for a text thread (`thread-sidebar.tsx`); opening the sidebar on a missing tab shows nothing.
    const isTextThread = (thread?.mode ?? "text") === "text";

    useEffect(() => {
        if (!isTextThread) {
            return undefined;
        }

        globalThis.addEventListener(ASK_ASIDE_EVENT, openAside);

        return () => {
            globalThis.removeEventListener(ASK_ASIDE_EVENT, openAside);
        };
    }, [isTextThread, openAside]);

    return null;
};

export default AskAsideShortcutListener;
