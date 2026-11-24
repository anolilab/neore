"use client";

import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import type { ChatClick } from "./chat-open-place";
import { chatOpenPlaceFor, readChatOpenPlace } from "./chat-open-place";
import { useIsDesktop } from "./desktop-layout";
import { openThreadBesideFocusedPane, requestComposerFocus, showThreadInSplitView } from "./split-layout-store";

/** Shows the chat's pane, if the saved layout can be read. The route still opens the chat when it cannot. */
const showPaneQuietly = async (threadId: string): Promise<void> => {
    try {
        await showThreadInSplitView(threadId);
    } catch {
        // The saved layout could not be read: the caller's navigation still opens the chat.
    }
};

/**
 * The click handler for a link to a chat (a sub-agent's, for now). It subscribes to the setting, the split view and the breakpoint, so
 * a link re-renders when any of them changes. `originThreadId` is the chat the link sits in: its pane is where the side panel opens.
 */
export const useOpenChatClick = (): ((threadId: string, click: ChatClick, originThreadId?: string) => void) => {
    const navigate = useNavigate();
    const chosenPlace = useUIStateStore((state) => readChatOpenPlace(state.preferences.subAgentOpenPlace));
    const isSplitViewOn = useUIStateStore((state) => state.preferences.splitViewEnabled === true);
    const isDesktop = useIsDesktop();

    return useCallback(
        (threadId, click, originThreadId) => {
            const openInMainView = async (): Promise<void> => {
                await navigate({ params: { threadId }, search: {}, to: "/chat/$threadId" });
            };

            // Below the breakpoint, or with the split view off, there is no side panel to open into.
            const place = chatOpenPlaceFor(chosenPlace, click, isSplitViewOn && isDesktop);

            if (place === "main") {
                // With the split view on, the main view is a pane too: a route that already names the chat does not move focus, so
                // the pane is shown first. A layout that cannot be read still opens the chat in the main view.
                const showInMainView = async () => {
                    if (isSplitViewOn) {
                        await showPaneQuietly(threadId);
                    }

                    await openInMainView();
                };

                void showInMainView();

                return;
            }

            // Every pane taken, or the layout unreadable: the chat opens in the main view, where it always opened.
            const openBeside = async () => {
                let result: "focused" | "full" | "opened" | undefined;

                try {
                    result = await openThreadBesideFocusedPane(threadId, originThreadId);
                } catch {
                    result = undefined;
                }

                // The split view may have been turned off while the layout was read: a pane then sits in a hidden layout, so the
                // chat opens in the main view instead.
                const isPaneVisible = (result === "focused" || result === "opened") && useUIStateStore.getState().preferences.splitViewEnabled === true;

                if (!isPaneVisible) {
                    if (isSplitViewOn) {
                        await showPaneQuietly(threadId);
                    }

                    await openInMainView();

                    return;
                }

                // A keyboard activation (`detail` 0) leaves focus on the link: the opened pane takes it, so the user reaches the chat.
                if (click.detail === 0) {
                    requestComposerFocus(threadId);
                }
            };

            void openBeside();
        },
        [chosenPlace, isDesktop, isSplitViewOn, navigate],
    );
};
