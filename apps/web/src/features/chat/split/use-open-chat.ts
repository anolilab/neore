"use client";

import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import type { ChatClick } from "./chat-open-place";
import { chatOpenPlaceFor, readChatOpenPlace } from "./chat-open-place";
import { useIsDesktop } from "./desktop-layout";
import { requestComposerFocus } from "./focus-composer";
import { openThreadBesideFocusedPane, showThreadInSplitView } from "./split-layout-store";

/** Whether the split view is on now. Read when it is needed: it can be turned off while a saved layout is being read. */
const isSplitViewOnNow = (): boolean => useUIStateStore.getState().preferences.splitViewEnabled === true;

/** Shows the chat's pane. Resolves to whether it is shown: a saved layout that cannot be read leaves it hidden, and the route still opens the chat. */
const showPaneQuietly = async (threadId: string): Promise<boolean> => {
    try {
        await showThreadInSplitView(threadId);

        return true;
    } catch {
        return false;
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

            // With the split view on, the chat's pane is shown first. A keyboard activation (`detail` 0) then moves focus into it, which
            // only a shown pane can take: a pane that is not shown never gets the request.
            const showPane = async (): Promise<void> => {
                if (!isSplitViewOnNow()) {
                    return;
                }

                const isShown = await showPaneQuietly(threadId);

                if (isShown && click.detail === 0) {
                    requestComposerFocus(threadId);
                }
            };

            // Below the breakpoint, or with the split view off, there is no side panel to open into.
            const place = chatOpenPlaceFor(chosenPlace, click, isSplitViewOn && isDesktop);

            if (place === "main") {
                // A route that already names the chat does not move focus, so the pane is shown before the route is read.
                const showInMainView = async () => {
                    await showPane();
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

                // The split view may have been turned off while the layout was read: a pane then sits in a hidden layout, so the chat opens
                // in the main view instead.
                const isPaneVisible = (result === "focused" || result === "opened") && isSplitViewOnNow();

                if (isPaneVisible) {
                    if (click.detail === 0) {
                        requestComposerFocus(threadId);
                    }

                    return;
                }

                await showPane();
                await openInMainView();
            };

            void openBeside();
        },
        [chosenPlace, isDesktop, isSplitViewOn, navigate],
    );
};
