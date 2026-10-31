"use client";

import { useSidebar } from "@neore/ui/components/sidebar";
import { useCallback } from "react";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

/** The right sidebar's tab that holds the side-question panel. */
export const ASIDE_TAB = "aside";

/** The panel's question field, so the button and the shortcut can move focus into it. */
export const ASIDE_INPUT_ID = "aside-question";

/**
 * Opens the right sidebar on the side-question tab and focuses its field.
 * Shared by the composer button and the `askAside` shortcut.
 */
const useOpenAside = (): (() => void) => {
    const setTab = useChatUIStore((state) => state.setActiveRightSidebarTab);
    const { setState } = useSidebar("right");

    return useCallback(() => {
        setTab(ASIDE_TAB);
        setState({ isMobileOpen: true, isOpen: true });
        // The tab is hidden until this render lands; the field exists but cannot take focus before it.
        globalThis.setTimeout(() => document.querySelector<HTMLElement>(`#${ASIDE_INPUT_ID}`)?.focus(), 50);
    }, [setState, setTab]);
};

export default useOpenAside;
