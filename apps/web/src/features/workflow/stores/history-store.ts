import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type { WorkflowContent } from "../types";
import { useWorkflowStore } from "./workflow-store";

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

export const HISTORY_DEBOUNCE_MS = 500;

const recorder: {
    baseline?: { content: WorkflowContent; key: string };
    isApplyingExternal: boolean;
    timer?: ReturnType<typeof setTimeout>;
} = { isApplyingExternal: false };

const currentGraph = (): { content: WorkflowContent; key: string } => {
    const { edges, nodes } = useWorkflowStore.getState().getContent();
    const content = { edges, nodes };

    return { content, key: JSON.stringify(content) };
};

const cancelPendingCommit = (): void => {
    clearTimeout(recorder.timer);
    recorder.timer = undefined;
};

const commit = (): void => {
    recorder.timer = undefined;

    if (useWorkflowStore.getState().nodes.some((node) => node.dragging)) {
        recorder.timer = setTimeout(commit, HISTORY_DEBOUNCE_MS);

        return;
    }

    const next = currentGraph();

    if (next.key === recorder.baseline?.key) {
        return;
    }

    const { entries, pushEntry } = useHistoryStore.getState();

    if (entries.length === 0 && recorder.baseline) {
        pushEntry(recorder.baseline.content);
    }

    pushEntry(next.content);
    recorder.baseline = next;
};

/** Commits a pending edit now, so the next write starts its own undo step. */
export const flushPendingHistory = (): void => {
    if (recorder.timer === undefined) {
        return;
    }

    cancelPendingCommit();
    commit();
};

/** Runs a store write that must not become an undo step: loads, remote applies, and history restores. */
export const withoutHistory = (apply: () => void): void => {
    // A local edit still inside the debounce window becomes its own step before the external write.
    flushPendingHistory();
    recorder.isApplyingExternal = true;

    try {
        apply();
    } finally {
        recorder.isApplyingExternal = false;
        recorder.baseline = currentGraph();
    }
};

const applyEntry = (entry: HistoryEntry | null | undefined): void => {
    try {
        if (entry) {
            withoutHistory(() => useWorkflowStore.getState().applySnapshot(entry.content));
        }
    } finally {
        useHistoryStore.getState().setNavigating(false);
    }
};

export const undoWorkflow = (): void => {
    flushPendingHistory();
    applyEntry(useHistoryStore.getState().undo());
};

export const redoWorkflow = (): void => {
    flushPendingHistory();
    applyEntry(useHistoryStore.getState().redo());
};

export const restoreWorkflowEntry = (id: string): void => {
    flushPendingHistory();
    applyEntry(useHistoryStore.getState().restoreEntry(id));
};

/** Records local graph edits as undo steps until the returned function is called. */
export const startHistoryRecording = (): (() => void) => {
    const resetHistory = (): void => {
        cancelPendingCommit();
        useHistoryStore.getState().clearHistory();
        recorder.baseline = currentGraph();
    };

    resetHistory();

    const stopGraph = useWorkflowStore.subscribe(
        (state) => [state.nodes, state.edges] as const,
        () => {
            if (recorder.isApplyingExternal) {
                return;
            }

            clearTimeout(recorder.timer);
            recorder.timer = setTimeout(commit, HISTORY_DEBOUNCE_MS);
        },
        { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] },
    );
    const stopProject = useWorkflowStore.subscribe((state) => state.projectId, resetHistory);

    return () => {
        stopGraph();
        stopProject();
        cancelPendingCommit();
    };
};

// Selector hooks
export const useHistoryEntries = () => useHistoryStore((state) => state.entries);
export const useCanUndo = () => useHistoryStore((state) => state.canUndo());
export const useCanRedo = () => useHistoryStore((state) => state.canRedo());
