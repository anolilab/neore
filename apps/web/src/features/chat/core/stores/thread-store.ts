"use client";

/**
 * Thread Store - Simplified
 *
 * Manages thread metadata for optimistic UI updates.
 * Thread ID comes from URL (TanStack Router) - URL is the source of truth.
 */

import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";

export interface ThreadMetadata {
    branchName?: string;
    branchPoint?: number;
    createdAt: Date;
    lastActivity: Date;
    parentThreadId?: string;
    status: "active" | "archived";
    title: string;
}

type SetStateAction<T> = T | ((previous: T) => T);

interface ThreadStore {
    // Optimistic deletion actions
    addOptimisticDeletion: (threadId: string) => void;

    clearOptimisticPin: (threadId: string) => void;
    clearOptimisticStatus: (threadId: string) => void;
    deleteThreadMetadata: (threadId: string) => void;

    optimisticDeletions: Set<string>; // threadIds that are optimistically deleted
    // Optimistic states for instant UI updates
    optimisticPins: Map<string, boolean>; // threadId -> isPinned
    optimisticStatuses: Map<string, "active" | "archived">; // threadId -> status

    removeOptimisticDeletion: (threadId: string) => void;
    reset: () => void;

    // Optimistic pin actions
    setOptimisticPin: (threadId: string, isPinned: boolean) => void;
    // Optimistic status actions
    setOptimisticStatus: (threadId: string, status: "active" | "archived") => void;

    setThreadMetadata: (updater: SetStateAction<Map<string, ThreadMetadata>>) => void;
    threadMetadata: Map<string, ThreadMetadata>;

    updateThreadMetadata: (threadId: string, metadata: Partial<ThreadMetadata>) => void;
}

const initialState = {
    optimisticDeletions: new Set<string>(),
    optimisticPins: new Map<string, boolean>(),
    optimisticStatuses: new Map<string, "active" | "archived">(),
    threadMetadata: new Map<string, ThreadMetadata>(),
};

const useThreadStore = create<ThreadStore>()(
    devtools(
        subscribeWithSelector((set) => {
            return {
                ...initialState,

                // Optimistic deletion actions
                addOptimisticDeletion: (threadId) => {
                    set((state) => {
                        const newDeletions = new Set(state.optimisticDeletions);

                        newDeletions.add(threadId);

                        return { optimisticDeletions: newDeletions };
                    });
                },

                clearOptimisticPin: (threadId) => {
                    set((state) => {
                        const newPins = new Map(state.optimisticPins);

                        newPins.delete(threadId);

                        return { optimisticPins: newPins };
                    });
                },

                clearOptimisticStatus: (threadId) => {
                    set((state) => {
                        const newStatuses = new Map(state.optimisticStatuses);

                        newStatuses.delete(threadId);

                        return { optimisticStatuses: newStatuses };
                    });
                },

                deleteThreadMetadata: (threadId) => {
                    set((state) => {
                        const newMetadata = new Map(state.threadMetadata);

                        newMetadata.delete(threadId);

                        return { threadMetadata: newMetadata };
                    });
                },

                removeOptimisticDeletion: (threadId) => {
                    set((state) => {
                        const newDeletions = new Set(state.optimisticDeletions);

                        newDeletions.delete(threadId);

                        return { optimisticDeletions: newDeletions };
                    });
                },

                reset: () => {
                    set(initialState);
                },

                // Optimistic pin actions
                setOptimisticPin: (threadId, isPinned) => {
                    set((state) => {
                        const newPins = new Map(state.optimisticPins);

                        newPins.set(threadId, isPinned);

                        return { optimisticPins: newPins };
                    });
                },

                // Optimistic status actions
                setOptimisticStatus: (threadId, status) => {
                    set((state) => {
                        const newStatuses = new Map(state.optimisticStatuses);

                        newStatuses.set(threadId, status);

                        return { optimisticStatuses: newStatuses };
                    });
                },

                setThreadMetadata: (updater) => {
                    set((state) => {
                        const newMetadata = typeof updater === "function" ? updater(state.threadMetadata) : updater;

                        return { threadMetadata: newMetadata };
                    });
                },

                updateThreadMetadata: (threadId, metadata) => {
                    set((state) => {
                        const existing = state.threadMetadata.get(threadId);
                        const updated = existing
                            ? { ...existing, ...metadata }
                            : ({
                                  createdAt: new Date(),
                                  lastActivity: new Date(),
                                  status: "active",
                                  title: "",
                                  ...metadata,
                              } as ThreadMetadata);

                        if (existing && Object.keys(metadata).every((key) => existing[key as keyof ThreadMetadata] === updated[key as keyof ThreadMetadata])) {
                            return state;
                        }

                        const newMetadata = new Map(state.threadMetadata);

                        newMetadata.set(threadId, updated);

                        return { threadMetadata: newMetadata };
                    });
                },
            };
        }),
        { enabled: process.env.NODE_ENV === "development", name: "thread-store" },
    ),
);

export default useThreadStore;
