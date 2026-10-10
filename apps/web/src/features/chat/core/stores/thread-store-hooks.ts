"use client";

import { useLocation } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";

import { LUNORA_ID_SOURCE } from "@/lib/lunora/ids";

import useThreadStore from "./thread-store";

const CHAT_THREAD_PATH_RE = new RegExp(`^/chat/(${LUNORA_ID_SOURCE})$`);

/**
 * Hook to get the current thread ID from URL (source of truth)
 * Returns the thread ID from the URL path, or undefined if on /chat route.
 */
export const useCurrentThreadId = (): string | undefined => {
    const location = useLocation();
    // Match /chat/{32-char-id} pattern
    const match = location.pathname.match(CHAT_THREAD_PATH_RE);

    return match?.[1];
};

// Thread state selectors
export const useThreadMetadata = () => useThreadStore((state) => state.threadMetadata);

// Optimistic state selectors
export const useOptimisticPins = () => useThreadStore((state) => state.optimisticPins);
export const useOptimisticStatuses = () => useThreadStore((state) => state.optimisticStatuses);
export const useOptimisticDeletions = () => useThreadStore((state) => state.optimisticDeletions);

// Thread actions - optimized with useShallow to prevent unnecessary re-renders
export const useThreadActions = () =>
    useThreadStore(
        useShallow((state) => {
            return {
                deleteThreadMetadata: state.deleteThreadMetadata,
                reset: state.reset,
                setThreadMetadata: state.setThreadMetadata,
                updateThreadMetadata: state.updateThreadMetadata,
            };
        }),
    );

// Optimistic actions for instant UI updates
export const useOptimisticActions = () =>
    useThreadStore(
        useShallow((state) => {
            return {
                addOptimisticDeletion: state.addOptimisticDeletion,
                clearOptimisticPin: state.clearOptimisticPin,
                clearOptimisticStatus: state.clearOptimisticStatus,
                removeOptimisticDeletion: state.removeOptimisticDeletion,
                setOptimisticPin: state.setOptimisticPin,
                setOptimisticStatus: state.setOptimisticStatus,
            };
        }),
    );
