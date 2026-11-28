"use client";

/**
 * Thread List UI Store
 *
 * Manages UI state shared between ThreadListHeader and ThreadList content.
 */

import type { Dispatch, SetStateAction } from "react";
import type { StateCreator } from "zustand";
import { create } from "zustand";
import { createJSONStorage, devtools, persist, subscribeWithSelector } from "zustand/middleware";

import { getAddProjectBridge } from "@/lib/native/bridge";

import type { SectionCounts, SectionKey } from "../lib/section-filter";
import { DEFAULT_SECTION_FILTER, EMPTY_SECTION_COUNTS, sanitizeSectionFilter } from "../lib/section-filter";

interface EditingProject {
    _id: string;
    color?: string;
    context?: string;
    defaultEnabledFeatures?: string[];
    defaultModel?: string;
    defaultReasoningEffort?: number;
    description?: string;
    icon?: string;
    title: string;
}

interface ThreadListUIState {
    editingProject: EditingProject | null;
    // Selection mode
    isSelectionMode: boolean;
    lastSelectedIndex: number;
    /** The thread whose options menu is open: its row's button, or the context-menu key. */
    optionsMenuThreadId: string | null;
    /** The thread the rename dialog is open for, opened by F2 or the options menu. */
    renameThreadId: string | null;
    searchQuery: string;
    searchType: "threads" | "messages";
    /** Thread counts per section, published by the list for the section bar (not saved). */
    sectionCounts: SectionCounts;
    /** The sections the list shows; saved. "active" alone is the normal list. */
    sectionFilter: ReadonlyArray<SectionKey>;

    selectedCategory: string | undefined;
    /** User tag filter; a thread matches when it carries any of these. */
    selectedTagIds: ReadonlyArray<string>;
    selectedThreadIds: Set<string>;
    // Add project dialog (machine picker): only opened when the desktop bridge is present
    showAddProjectDialog: boolean;

    // Keyboard help
    showKeyboardHelp: boolean;

    // Tag manager dialog
    showManageTagsDialog: boolean;

    // Project form dialog
    showProjectFormDialog: boolean;

    // Search state
    showSearch: boolean;
    /** The thread the "Snooze until…" dialog is open for. The list renders the dialog, so it outlives the row. */
    snoozeThreadId: string | null;
}

interface ThreadListUIActions {
    closeAddProjectDialog: () => void;
    closeProjectFormDialog: () => void;
    // Selection mode actions - supports both direct values and functional updates
    enterSelectionMode: () => void;
    exitSelectionMode: () => void;
    /** The header action: the machine picker with the desktop bridge, the project form without. */
    openAddProjectDialog: () => void;
    /** The "Clone or create new…" exit of the Add project dialog: closes it and opens the project form. */
    openCreateProjectDialog: () => void;
    // Reset
    reset: () => void;

    setEditingProject: (project: EditingProject | null) => void;
    setLastSelectedIndex: Dispatch<SetStateAction<number>>;
    setOptionsMenuThreadId: (threadId: string | null) => void;
    setRenameThreadId: (threadId: string | null) => void;
    setSearchQuery: (query: string) => void;
    setSearchType: (type: "threads" | "messages") => void;
    setSectionCounts: (counts: SectionCounts) => void;
    setSectionFilter: (filter: ReadonlyArray<SectionKey>) => void;
    setSelectedCategory: (category: string | undefined) => void;

    setSelectedTagIds: (tagIds: ReadonlyArray<string>) => void;
    setSelectedThreadIds: Dispatch<SetStateAction<Set<string>>>;
    // Keyboard help actions - supports both direct values and functional updates
    setShowKeyboardHelp: Dispatch<SetStateAction<boolean>>;

    setShowManageTagsDialog: (show: boolean) => void;
    // Project form dialog actions
    setShowProjectFormDialog: (show: boolean) => void;
    // Search actions - supports both direct values and functional updates
    setShowSearch: Dispatch<SetStateAction<boolean>>;
    setSnoozeThreadId: (threadId: string | null) => void;
    toggleShowKeyboardHelp: () => void;

    toggleShowSearch: () => void;
}

type ThreadListUIStore = ThreadListUIActions & ThreadListUIState;

const initialState: ThreadListUIState = {
    editingProject: null,
    isSelectionMode: false,
    lastSelectedIndex: -1,
    searchQuery: "",
    searchType: "threads",
    sectionCounts: EMPTY_SECTION_COUNTS,
    sectionFilter: DEFAULT_SECTION_FILTER,
    selectedCategory: undefined,
    selectedTagIds: [],
    optionsMenuThreadId: null,
    renameThreadId: null,
    snoozeThreadId: null,
    selectedThreadIds: new Set(),
    showKeyboardHelp: false,
    showManageTagsDialog: false,
    showAddProjectDialog: false,
    showProjectFormDialog: false,
    showSearch: false,
};

// Helper to resolve SetStateAction
const resolveSetStateAction = <T>(action: SetStateAction<T>, currentValue: T): T =>
    typeof action === "function" ? (action as (previous: T) => T)(currentValue) : action;

/** The saved section filter lives in this browser; a browser that refuses storage just starts from the default each time. */
/** Set once the saved section choice has been read back (`onRehydrateStorage`). */
const sectionFilterHydration = { done: false };

const sectionFilterStorage = {
    getItem: (name: string): string | null => {
        try {
            return localStorage.getItem(name);
        } catch {
            return null;
        }
    },
    removeItem: (name: string): void => {
        try {
            localStorage.removeItem(name);
        } catch {
            // Nothing saved, nothing to remove.
        }
    },
    setItem: (name: string, value: string): void => {
        // Every set() writes, and the list publishes its counts before the section bar has read the saved choice back: a write
        // before that would replace the saved choice with the default.
        if (!sectionFilterHydration.done) {
            return;
        }

        try {
            localStorage.setItem(name, value);
        } catch {
            // The choice holds for this visit only.
        }
    },
};

/** Split out of the `create()(devtools(persist(subscribeWithSelector(…))))` chain so no call sits four levels deep. */
const initialiseState: StateCreator<ThreadListUIStore> = (set) => {
    return {
        ...initialState,

        closeAddProjectDialog: () => set({ showAddProjectDialog: false }),
        closeProjectFormDialog: () => set({ showProjectFormDialog: false }),
        // Selection mode actions
        enterSelectionMode: () =>
            set({
                isSelectionMode: true,
                lastSelectedIndex: -1,
                selectedThreadIds: new Set(),
            }),
        exitSelectionMode: () =>
            set({
                isSelectionMode: false,
                lastSelectedIndex: -1,
                selectedThreadIds: new Set(),
            }),
        openAddProjectDialog: () =>
            set(getAddProjectBridge() === undefined ? { editingProject: null, showProjectFormDialog: true } : { showAddProjectDialog: true }),
        openCreateProjectDialog: () =>
            set({
                editingProject: null,
                showAddProjectDialog: false,
                showProjectFormDialog: true,
            }),
        // Reset
        // Back to the defaults, the section choice and its counts included.
        reset: () => set({ ...initialState, sectionCounts: EMPTY_SECTION_COUNTS, sectionFilter: DEFAULT_SECTION_FILTER }),
        setOptionsMenuThreadId: (threadId) => set({ optionsMenuThreadId: threadId }),
        setRenameThreadId: (threadId) => set({ renameThreadId: threadId }),
        setSnoozeThreadId: (threadId) => set({ snoozeThreadId: threadId }),

        setEditingProject: (project) => set({ editingProject: project }),
        setLastSelectedIndex: ((action: SetStateAction<number>) =>
            set((state) => {
                return {
                    lastSelectedIndex: resolveSetStateAction(action, state.lastSelectedIndex),
                };
            })) as Dispatch<SetStateAction<number>>,
        setSearchQuery: (query) => set({ searchQuery: query }),
        setSearchType: (type) => set({ searchType: type }),
        setSectionCounts: (counts) => set({ sectionCounts: counts }),
        // A selection made in one section would otherwise stay selected, unseen, in the next one, and bulk delete acts on all of it.
        // The shift-click anchor indexes the previous section's rows, so it goes with the selection.
        setSectionFilter: (filter) => set({ lastSelectedIndex: -1, sectionFilter: sanitizeSectionFilter(filter), selectedThreadIds: new Set() }),

        setSelectedCategory: (category) => set({ selectedCategory: category }),
        setSelectedTagIds: (tagIds) => set({ selectedTagIds: tagIds }),
        setSelectedThreadIds: ((action: SetStateAction<Set<string>>) =>
            set((state) => {
                return {
                    selectedThreadIds: resolveSetStateAction(action, state.selectedThreadIds),
                };
            })) as Dispatch<SetStateAction<Set<string>>>,

        // Keyboard help actions
        setShowKeyboardHelp: ((action: SetStateAction<boolean>) =>
            set((state) => {
                return {
                    showKeyboardHelp: resolveSetStateAction(action, state.showKeyboardHelp),
                };
            })) as Dispatch<SetStateAction<boolean>>,
        setShowManageTagsDialog: (show) => set({ showManageTagsDialog: show }),
        // Project form dialog actions
        setShowProjectFormDialog: (show) => set({ showProjectFormDialog: show }),
        // Search actions
        setShowSearch: ((action: SetStateAction<boolean>) =>
            set((state) => {
                return {
                    showSearch: resolveSetStateAction(action, state.showSearch),
                };
            })) as Dispatch<SetStateAction<boolean>>,
        toggleShowKeyboardHelp: () =>
            set((state) => {
                return { showKeyboardHelp: !state.showKeyboardHelp };
            }),

        toggleShowSearch: () =>
            set((state) => {
                return { showSearch: !state.showSearch };
            }),
    };
};

const persistedState = persist(subscribeWithSelector(initialiseState), {
    // Nothing saved (none yet, or storage blocked) keeps the choice in memory: the bar rehydrates on every mount, and a reset
    // to Active would drop the section picked earlier in this visit.
    merge: (persisted, current) => {
        const saved = (persisted as { sectionFilter?: unknown } | undefined)?.sectionFilter;

        return { ...current, sectionFilter: saved === undefined ? current.sectionFilter : sanitizeSectionFilter(saved) };
    },
    name: "thread-list-sections",
    onRehydrateStorage: () => () => {
        sectionFilterHydration.done = true;
    },
    partialize: (state) => {
        return { sectionFilter: state.sectionFilter };
    },
    skipHydration: true,
    storage: createJSONStorage(() => sectionFilterStorage),
    version: 1,
});

/**
 * Hydration is manual (`persist.rehydrate()`, called by the section bar once mounted), so the server render and the first client
 * render agree on which sections are pressed.
 */
export const useThreadListUIStore = create<ThreadListUIStore>()(
    devtools(persistedState, { enabled: process.env.NODE_ENV === "development", name: "thread-list-ui-store" }),
);

// Stable selector functions - define outside components for stable references
export const selectShowSearch = (state: ThreadListUIStore) => state.showSearch;
export const selectSearchQuery = (state: ThreadListUIStore) => state.searchQuery;
export const selectSearchType = (state: ThreadListUIStore) => state.searchType;
export const selectSectionFilter = (state: ThreadListUIStore) => state.sectionFilter;
export const selectSectionCounts = (state: ThreadListUIStore) => state.sectionCounts;
export const selectSelectedCategory = (state: ThreadListUIStore) => state.selectedCategory;
export const selectSelectedTagIds = (state: ThreadListUIStore) => state.selectedTagIds;
export const selectShowManageTagsDialog = (state: ThreadListUIStore) => state.showManageTagsDialog;
export const selectIsSelectionMode = (state: ThreadListUIStore) => state.isSelectionMode;
export const selectSelectedThreadIds = (state: ThreadListUIStore) => state.selectedThreadIds;
export const selectLastSelectedIndex = (state: ThreadListUIStore) => state.lastSelectedIndex;
export const selectShowKeyboardHelp = (state: ThreadListUIStore) => state.showKeyboardHelp;
export const selectShowProjectFormDialog = (state: ThreadListUIStore) => state.showProjectFormDialog;
export const selectEditingProject = (state: ThreadListUIStore) => state.editingProject;

// Action selectors
export const selectSetShowSearch = (state: ThreadListUIStore) => state.setShowSearch;
export const selectToggleShowSearch = (state: ThreadListUIStore) => state.toggleShowSearch;
export const selectSetSearchQuery = (state: ThreadListUIStore) => state.setSearchQuery;
export const selectSetSearchType = (state: ThreadListUIStore) => state.setSearchType;
export const selectSetSelectedCategory = (state: ThreadListUIStore) => state.setSelectedCategory;
export const selectSetSelectedTagIds = (state: ThreadListUIStore) => state.setSelectedTagIds;
export const selectSetShowManageTagsDialog = (state: ThreadListUIStore) => state.setShowManageTagsDialog;
export const selectEnterSelectionMode = (state: ThreadListUIStore) => state.enterSelectionMode;
export const selectExitSelectionMode = (state: ThreadListUIStore) => state.exitSelectionMode;
export const selectSetSelectedThreadIds = (state: ThreadListUIStore) => state.setSelectedThreadIds;
export const selectSetLastSelectedIndex = (state: ThreadListUIStore) => state.setLastSelectedIndex;
export const selectSetShowKeyboardHelp = (state: ThreadListUIStore) => state.setShowKeyboardHelp;
export const selectToggleShowKeyboardHelp = (state: ThreadListUIStore) => state.toggleShowKeyboardHelp;
export const selectShowAddProjectDialog = (state: ThreadListUIStore) => state.showAddProjectDialog;
export const selectOpenAddProjectDialog = (state: ThreadListUIStore) => state.openAddProjectDialog;
export const selectCloseAddProjectDialog = (state: ThreadListUIStore) => state.closeAddProjectDialog;
export const selectOpenCreateProjectDialog = (state: ThreadListUIStore) => state.openCreateProjectDialog;
export const selectCloseProjectFormDialog = (state: ThreadListUIStore) => state.closeProjectFormDialog;
