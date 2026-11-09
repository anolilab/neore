import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

import { useParkedDraftStore, useSplitViewMountedStore } from "./composer-drafts";
import { useSplitLayoutStore } from "./split-layout-store";

/**
 * Whether the chat has unsent text, attachments or references: parked, or live in the composer when it is the focused pane
 * of a split view that is on the page. Boolean selectors, so a row re-renders only when its own answer changes.
 */
export const useChatHasDraft = (threadId: string): boolean => {
    const isParked = useParkedDraftStore((state) => state.threadIds.has(threadId));
    const isMounted = useSplitViewMountedStore((state) => state.mounted);
    const isFocusedPane = useSplitLayoutStore((state) => state.layout.panes[state.layout.focus] === threadId);
    const isFocused = isMounted && isFocusedPane;
    const hasLiveDraft = useChatUIStore(
        (state) => isFocused && (state.composerText !== "" || state.composerAttachments.length > 0 || state.attachedReferences.length > 0),
    );

    return isParked || hasLiveDraft;
};
