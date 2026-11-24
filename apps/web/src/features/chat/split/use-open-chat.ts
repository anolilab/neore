"use client";

import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";
import { showWarning } from "@/lib/toast";

import type { ChatClick } from "./chat-open-place";
import { chatOpenPlaceFor, readChatOpenPlace } from "./chat-open-place";
import { openThreadInSplitView } from "./split-layout-store";

/**
 * The click handler for a link to a chat (a sub-agent's, for now). Read at each click: the setting and the split view are not
 * subscribed to, so a link never re-renders because of them.
 */
export const useOpenChatClick = (): ((threadId: string, click: ChatClick) => void) => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const chosenPlace = useUIStateStore((state) => readChatOpenPlace(state.preferences.subAgentOpenPlace));
    const isSplitViewOn = useUIStateStore((state) => state.preferences.splitViewEnabled === true);

    return useCallback(
        (threadId, click) => {
            const place = chatOpenPlaceFor(chosenPlace, click, isSplitViewOn);

            if (place === "main") {
                void navigate({ params: { threadId }, search: {}, to: "/chat/$threadId" });

                return;
            }

            const openBeside = async () => {
                const result = await openThreadInSplitView(threadId);

                if (result === "full") {
                    showWarning(t`Split view is full. Close a chat first.`);
                }
            };

            void openBeside();
        },
        [chosenPlace, isSplitViewOn, navigate, t],
    );
};
