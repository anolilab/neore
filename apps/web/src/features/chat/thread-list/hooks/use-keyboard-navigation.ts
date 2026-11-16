import { useCallback, useState } from "react";

import { useThreadListUIStore } from "../stores/thread-list-ui-store";
import { isThreadLocked } from "../thread-lock";
import type { BranchNode } from "../types";

interface UseKeyboardNavigationOptions {
    flattenedThreads: BranchNode[];
    navigate: (params: { threadId: string }) => void;
}

/**
 * Whether the person can see this thread's row: some mounted copy of it is laid out. A row the virtualizer has unmounted is gone, and
 * a row in a hidden list (a collapsed sidebar, another layout's copy of the list) has no box. Keys act only on such a row, so a
 * menu or a rename cannot appear later on a row the person does not see.
 */
const isRowShown = (threadId: string): boolean =>
    [...document.querySelectorAll<HTMLElement>("[data-thread-id]")].some((row) => row.dataset.threadId === threadId && row.getClientRects().length > 0);

const useKeyboardNavigation = ({ flattenedThreads, navigate }: UseKeyboardNavigationOptions) => {
    const [selectedThreadIndex, setSelectedThreadIndex] = useState<number>(-1);
    const [isKeyboardNavigating, setIsKeyboardNavigating] = useState(false);

    // Clamped while rendering rather than written back through an effect: when
    // the list shrinks under the cursor, the selection follows it in the same
    // render instead of one cascading render later.
    const clampedIndex = isKeyboardNavigating && selectedThreadIndex >= flattenedThreads.length ? flattenedThreads.length - 1 : selectedThreadIndex;

    const handleArrowDown = useCallback(() => {
        setIsKeyboardNavigating(true);
        setSelectedThreadIndex((previous) => {
            const totalThreads = flattenedThreads.length;
            const current = Math.min(previous, totalThreads - 1);

            return current >= totalThreads - 1 ? 0 : current + 1;
        });
    }, [flattenedThreads.length]);

    const handleArrowUp = useCallback(() => {
        setIsKeyboardNavigating(true);
        setSelectedThreadIndex((previous) => {
            const totalThreads = flattenedThreads.length;
            const current = Math.min(previous, totalThreads - 1);

            return (current <= 0 ? totalThreads : current) - 1;
        });
    }, [flattenedThreads.length]);

    const handleEnter = useCallback(() => {
        if (!(isKeyboardNavigating && clampedIndex >= 0 && clampedIndex < flattenedThreads.length)) {
            return;
        }

        const selectedThread = flattenedThreads[clampedIndex]!;

        navigate({ threadId: selectedThread.threadId });
        setIsKeyboardNavigating(false);
        setSelectedThreadIndex(-1);
    }, [isKeyboardNavigating, clampedIndex, flattenedThreads, navigate]);

    const handleEscape = useCallback(() => {
        setIsKeyboardNavigating(false);
        setSelectedThreadIndex(-1);
    }, []);

    // F2 and the context-menu key act on the keyboard's selected thread. A locked chat takes neither a rename nor a menu.
    const selectedThread = isKeyboardNavigating && clampedIndex >= 0 && clampedIndex < flattenedThreads.length ? flattenedThreads[clampedIndex] : undefined;

    const handleRenameSelected = useCallback(() => {
        if (selectedThread && !isThreadLocked(selectedThread.lockedAt) && isRowShown(selectedThread.threadId)) {
            useThreadListUIStore.getState().setRenameThreadId(selectedThread.threadId);
        }
    }, [selectedThread]);

    // Opens the selected thread's menu and reports that it did. A locked row has no menu (a mouse click gets none either), and a row
    // the person cannot see gets none either: nothing opens and the caller leaves the key to the browser.
    const handleOpenSelectedMenu = useCallback((): boolean => {
        if (!selectedThread || isThreadLocked(selectedThread.lockedAt) || !isRowShown(selectedThread.threadId)) {
            return false;
        }

        useThreadListUIStore.getState().setOptionsMenuThreadId(selectedThread.threadId);

        return true;
    }, [selectedThread]);

    const resetNavigation = useCallback(() => {
        setIsKeyboardNavigating(false);
        setSelectedThreadIndex(-1);
    }, []);

    return {
        handleArrowDown,
        handleArrowUp,
        handleEnter,
        handleEscape,
        handleOpenSelectedMenu,
        handleRenameSelected,
        isKeyboardNavigating,
        resetNavigation,
        selectedThreadIndex: clampedIndex,
    };
};

export default useKeyboardNavigation;
