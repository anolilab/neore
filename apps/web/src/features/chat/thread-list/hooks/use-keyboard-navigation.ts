import { useCallback, useState } from "react";

import type { BranchNode } from "../types";

interface UseKeyboardNavigationOptions {
    flattenedThreads: BranchNode[];
    navigate: (params: { threadId: string }) => void;
}

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

    const resetNavigation = useCallback(() => {
        setIsKeyboardNavigating(false);
        setSelectedThreadIndex(-1);
    }, []);

    return {
        handleArrowDown,
        handleArrowUp,
        handleEnter,
        handleEscape,
        isKeyboardNavigating,
        resetNavigation,
        selectedThreadIndex: clampedIndex,
    };
};

export default useKeyboardNavigation;
