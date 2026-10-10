"use client";

/**
 * Thread List UI Store
 *
 * Manages UI state shared between ThreadListHeader and ThreadList content.
 */

import type { Dispatch, SetStateAction } from "react";
import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";

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
    searchQuery: string;

    searchType: "threads" | "messages";
    selectedCategory: string | undefined;
    /** User tag filter; a thread matches when it carries any of these. */
    selectedTagIds: ReadonlyArray<string>;
    selectedThreadIds: Set<string>;

    // Keyboard help
    showKeyboardHelp: boolean;

    // Tag manager dialog
    showManageTagsDialog: boolean;

    // Project form dialog
    showProjectFormDialog: boolean;
    // Search state
    showSearch: boolean;
}

interface ThreadListUIActions {
    closeProjectFormDialog: () => void;
    // Selection mode actions - supports both direct values and functional updates
    enterSelectionMode: () => void;
    exitSelectionMode: () => void;
    openCreateProjectDialog: () => void;
    // Reset
    reset: () => void;

    setEditingProject: (project: EditingProject | null) => void;
    setLastSelectedIndex: Dispatch<SetStateAction<number>>;
    setSearchQuery: (query: string) => void;
    setSearchType: (type: "threads" | "messages") => void;

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
    selectedCategory: undefined,
    selectedTagIds: [],
    selectedThreadIds: new Set(),
    showKeyboardHelp: false,
    showManageTagsDialog: false,
    showProjectFormDialog: false,
    showSearch: false,
};

// Helper to resolve SetStateAction
const resolveSetStateAction = <T>(action: SetStateAction<T>, currentValue: T): T =>
    typeof action === "function" ? (action as (previous: T) => T)(currentValue) : action;

export const useThreadListUIStore = create<ThreadListUIStore>()(
    devtools(
        subscribeWithSelector((set) => {
            return {
                ...initialState,

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
                openCreateProjectDialog: () =>
                    set({
                        editingProject: null,
                        showProjectFormDialog: true,
                    }),
                // Reset
                reset: () => set(initialState),

                setEditingProject: (project) => set({ editingProject: project }),
                setLastSelectedIndex: ((action: SetStateAction<number>) =>
                    set((state) => {
                        return {
                            lastSelectedIndex: resolveSetStateAction(action, state.lastSelectedIndex),
                        };
                    })) as Dispatch<SetStateAction<number>>,
                setSearchQuery: (query) => set({ searchQuery: query }),
                setSearchType: (type) => set({ searchType: type }),

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
        }),
        { enabled: process.env.NODE_ENV === "development", name: "thread-list-ui-store" },
    ),
);

// Stable selector functions - define outside components for stable references
export const selectShowSearch = (state: ThreadListUIStore) => state.showSearch;
export const selectSearchQuery = (state: ThreadListUIStore) => state.searchQuery;
export const selectSearchType = (state: ThreadListUIStore) => state.searchType;
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
export const selectOpenCreateProjectDialog = (state: ThreadListUIStore) => state.openCreateProjectDialog;
export const selectCloseProjectFormDialog = (state: ThreadListUIStore) => state.closeProjectFormDialog;
