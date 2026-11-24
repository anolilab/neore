"use client";

import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import type { ChatClick } from "./chat-open-place";
import { chatOpenPlaceFor, readChatOpenPlace } from "./chat-open-place";
import { useIsDesktop } from "./desktop-layout";
import { openThreadBesideFocusedPane, showThreadInSplitView } from "./split-layout-store";

/**
 * The click handler for a link to a chat (a sub-agent's, for now). It subscribes to the setting, the split view and the breakpoint, so
 * a link re-renders when any of them changes.
 */
export const useOpenChatClick = (): ((threadId: string, click: ChatClick) => void) => {
    const navigate = useNavigate();
    const chosenPlace = useUIStateStore((state) => readChatOpenPlace(state.preferences.subAgentOpenPlace));
    const isSplitViewOn = useUIStateStore((state) => state.preferences.splitViewEnabled === true);
    const isDesktop = useIsDesktop();

    return useCallback(
        (threadId, click) => {
            const openInMainView = async (): Promise<void> => {
                await navigate({ params: { threadId }, search: {}, to: "/chat/$threadId" });
            };

            // Below the breakpoint, or with the split view off, there is no side panel to open into.
            const place = chatOpenPlaceFor(chosenPlace, click, isSplitViewOn && isDesktop);

            if (place === "main") {
                // With the split view on, the main view is a pane too: a route that already names the chat does not move focus, so
                // the pane is shown first.
                const showInMainView = async () => {
                    if (isSplitViewOn) {
                        await showThreadInSplitView(threadId);
                    }

                    await openInMainView();
                };

                void showInMainView();

                return;
            }

            // Every pane taken: the chat opens in the main view, where it always opened. A route that already names the chat does not
            // move, so its pane is shown first, as on the main view.
            const openBeside = async () => {
                const result = await openThreadBesideFocusedPane(threadId);

                if (result === "full") {
                    await showThreadInSplitView(threadId);
                    await openInMainView();
                }
            };

            void openBeside();
        },
        [chosenPlace, isDesktop, isSplitViewOn, navigate],
    );
};
