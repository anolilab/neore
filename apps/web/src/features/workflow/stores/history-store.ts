import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type { WorkflowContent } from "../types";

export const MAX_HISTORY_ENTRIES = 50;

/**
 * A snapshot of the workflow state at a point in time
 */
export interface HistoryEntry {
    content: WorkflowContent;
    id: string;
    isAutoSave?: boolean;
    label?: string;
    timestamp: number;
}

interface HistoryState {
    canRedo: () => boolean;

    canUndo: () => boolean;

    clearHistory: () => void;

    // Current position in history (for undo/redo)
    currentIndex: number;
    // History entries (newest first)
    entries: HistoryEntry[];
    getEntry: (id: string) => HistoryEntry | undefined;
    // Whether we're currently in a history navigation
    isNavigating: boolean;
    // Actions
    pushEntry: (content: WorkflowContent, label?: string, isAutoSave?: boolean) => void;
    redo: () => HistoryEntry | null;
    restoreEntry: (id: string) => HistoryEntry | undefined;
    setNavigating: (isNavigating: boolean) => void;
    undo: () => HistoryEntry | null;
}

export const useHistoryStore = create<HistoryState>()(
    subscribeWithSelector((set, get) => {
        return {
            canRedo: () => {
                const { currentIndex } = get();

                return currentIndex > 0;
            },
            canUndo: () => {
                const { currentIndex, entries } = get();

                return currentIndex < entries.length - 1;
            },
            clearHistory: () => {
                set({
                    currentIndex: -1,
                    entries: [],
                    isNavigating: false,
                });
            },

            currentIndex: -1,

            entries: [],

            getEntry: (id) => get().entries.find((e) => e.id === id),

            isNavigating: false,

            pushEntry: (content, label, isAutoSave = false) => {
                const { currentIndex, entries, isNavigating } = get();

                // Don't add to history while navigating (restoring)
                if (isNavigating) {
                    return;
                }

                const newEntry: HistoryEntry = {
                    content: structuredClone(content),
                    id: `history-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`,
                    isAutoSave,
                    label,
                    timestamp: Date.now(),
                };

                // If we've undone some entries, discard the redo branch (entries newer than current).
                // Entries are newest-first, so indices 0..currentIndex-1 are the redo entries to discard.
                const newEntries = currentIndex > 0 ? entries.slice(currentIndex) : [...entries];

                // Add new entry
                newEntries.unshift(newEntry);

                // Limit history size
                if (newEntries.length > MAX_HISTORY_ENTRIES) {
                    newEntries.splice(MAX_HISTORY_ENTRIES);
                }

                set({
                    currentIndex: 0,
                    entries: newEntries,
                });
            },

            redo: () => {
                const { currentIndex, entries } = get();

                if (currentIndex <= 0) {
                    return null;
                }

                const newIndex = currentIndex - 1;
                const entry = entries[newIndex];

                if (entry) {
                    set({ currentIndex: newIndex, isNavigating: true });

                    return entry;
                }

                return null;
            },

            restoreEntry: (id) => {
                const { entries } = get();
                const entryIndex = entries.findIndex((e) => e.id === id);

                if (entryIndex !== -1) {
                    set({ currentIndex: entryIndex, isNavigating: true });

                    return entries[entryIndex];
                }

                return undefined;
            },

            setNavigating: (isNavigating) => {
                set({ isNavigating });
            },

            undo: () => {
                const { currentIndex, entries } = get();

                if (currentIndex >= entries.length - 1) {
                    return null;
                }

                const newIndex = currentIndex + 1;
                const entry = entries[newIndex];

                if (entry) {
                    set({ currentIndex: newIndex, isNavigating: true });

                    return entry;
                }

                return null;
            },
        };
    }),
);

// Selector hooks
export const useHistoryEntries = () => useHistoryStore((state) => state.entries);
export const useCanUndo = () => useHistoryStore((state) => state.canUndo());
export const useCanRedo = () => useHistoryStore((state) => state.canRedo());
