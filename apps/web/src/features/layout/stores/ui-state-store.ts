"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AccentId } from "@/features/appearance/lib/accent-presets";
import type { CodeHighlightThemeId, MermaidThemeId } from "@/features/appearance/lib/code-themes";

const platformModifier = "ctrl";

export type SidebarStateValue = {
    isMobileOpen: boolean;
    isOpen: boolean;
};

export type SearchState = {
    isOpen: boolean;
    query: string;
    recentSearches: string[];
    type: "threads" | "messages" | "global";
};

export type ModalState = {
    data?: unknown;
    isOpen: boolean;
};

export type FontSettings = {
    codeFont: "fira-code" | "mono" | "consolas" | "jetbrains" | "source-code-pro";
    mainFont: "inter" | "system" | "serif" | "mono" | "roboto-slab";
};

/** Accent colour, code-block and diagram themes — see `features/appearance`. */
export type AppearanceSettings = {
    accentColor: AccentId;
    codeHighlightTheme: CodeHighlightThemeId;
    mermaidTheme: MermaidThemeId;
};

export type KeyboardShortcuts = {
    archiveThread: string;
    audioRecord: string;
    commandPalette: string;
    createBranch: string;
    deleteThread: string;
    escape: string;
    firstItem: string;
    focusSearch: string;
    help: string;
    lastItem: string;
    newChat: string;
    newTemporaryChat: string;
    nextItem: string;
    pinThread: string;
    prevItem: string;
    search: string;
    sidebarLeft: string;
    sidebarRight: string;
};

export type Direction = "ltr" | "rtl";

export type LayoutState = {
    density: "compact" | "comfortable" | "spacious";
    direction: Direction;
    fontSize: "small" | "medium" | "large";
    showAvatars: boolean;
    showTimestamps: boolean;
};

export type UserPreferences = {
    animations: boolean;
    autoSave: boolean;
    disableExternalLinkWarning: boolean;
    hidePersonalInfo: boolean;
    isAdvancedUser: boolean;
    lastChatId?: string;
    onboardingCompleted: boolean;
    sendBehavior: "enter" | "shiftEnter" | "button";
    showTimestamps: boolean;
    soundEffects: boolean;
};

const defaultKeyboardShortcuts: KeyboardShortcuts = {
    archiveThread: `${platformModifier}+a`,
    audioRecord: `${platformModifier}+shift+r`,
    commandPalette: `${platformModifier}+k`,
    createBranch: `${platformModifier}+shift+c`,
    deleteThread: `${platformModifier}+d`,
    escape: "escape",
    firstItem: "home",
    focusSearch: `${platformModifier}+f`,
    help: `${platformModifier}+/`,
    lastItem: "end",
    newChat: `${platformModifier}+n`,
    newTemporaryChat: `${platformModifier}+shift+n`,
    nextItem: "arrowdown",
    pinThread: `${platformModifier}+p`,
    prevItem: "arrowup",
    search: `${platformModifier}+k`,
    sidebarLeft: `${platformModifier}+b`,
    sidebarRight: `${platformModifier}+shift+b`,
};

const RIGHT_SIDEBAR_DEFAULT_WIDTH = 280;

export const RIGHT_SIDEBAR_MIN_WIDTH = 240;
export const RIGHT_SIDEBAR_MAX_WIDTH = 600;

const defaultUIState = {
    appearance: { accentColor: "default", codeHighlightTheme: "default", mermaidTheme: "default" } as AppearanceSettings,
    fonts: { codeFont: "fira-code" as const, mainFont: "inter" as const },
    keyboardShortcuts: defaultKeyboardShortcuts,
    layout: { density: "comfortable" as const, direction: "ltr" as const, fontSize: "medium" as const, showAvatars: true, showTimestamps: true },
    modals: {} as Record<string, ModalState>,
    preferences: {
        animations: true,
        autoSave: true,
        disableExternalLinkWarning: false,
        hidePersonalInfo: false,
        isAdvancedUser: false,
        onboardingCompleted: false,
        sendBehavior: "enter" as const,
        showTimestamps: true,
        soundEffects: false,
    },
    rightSidebarWidth: RIGHT_SIDEBAR_DEFAULT_WIDTH,
    search: { isOpen: false, query: "", recentSearches: [], type: "threads" as const },
    sidebars: {
        left: { isMobileOpen: false, isOpen: true },
        right: { isMobileOpen: false, isOpen: false },
    } as Record<string, SidebarStateValue>,
};

interface UIStateStore {
    // Actions
    addRecentSearch: (query: string) => void;
    appearance: AppearanceSettings;
    clearRecentSearches: () => void;
    closeAllModals: () => void;
    closeModal: (modalName: string) => void;
    fonts: FontSettings;
    initializeSidebarStates: (sidebarNames: string[], defaultOpenState: "all" | string[]) => Record<string, SidebarStateValue>;
    keyboardShortcuts: KeyboardShortcuts;
    layout: LayoutState;
    modals: Record<string, ModalState>;
    openModal: (modalName: string, data?: unknown) => void;
    preferences: UserPreferences;
    resetAppearance: () => void;
    resetFonts: () => void;
    resetKeyboardShortcuts: () => void;
    resetLayout: () => void;
    resetSidebarStates: () => void;
    resetUIState: () => void;
    resetUserPreferences: () => void;
    rightSidebarWidth: number;
    search: SearchState;
    setAppearance: (appearance: Partial<AppearanceSettings>) => void;
    setFonts: (fonts: Partial<FontSettings>) => void;
    setKeyboardShortcuts: (shortcuts: Partial<KeyboardShortcuts>) => void;
    setLayoutState: (layout: Partial<LayoutState>) => void;
    setModalState: (modalName: string, state: Partial<ModalState>) => void;
    setRightSidebarWidth: (width: number) => void;
    setSearchState: (searchState: Partial<SearchState>) => void;
    setSidebarStates: (states: Record<string, SidebarStateValue>) => void;
    setUserPreferences: (preferences: Partial<UserPreferences>) => void;
    sidebars: Record<string, SidebarStateValue>;
    toggleSidebar: (sidebarName: string) => void;
}

export const useUIStateStore = create<UIStateStore>()(
    persist(
        (set) => {
            return {
                ...defaultUIState,
                addRecentSearch: (query: string) => {
                    if (!query.trim()) {
                        return;
                    }

                    set((state) => {
                        const recentSearches = state.search.recentSearches || [];
                        const filteredSearches = recentSearches.filter((search) => search !== query);

                        return {
                            search: {
                                ...state.search,
                                recentSearches: [query, ...filteredSearches].slice(0, 10),
                            },
                        };
                    });
                },
                clearRecentSearches: () => {
                    set((state) => {
                        return {
                            search: {
                                ...state.search,
                                recentSearches: [],
                            },
                        };
                    });
                },
                closeAllModals: () => {
                    set((state) => {
                        const modals: Record<string, ModalState> = {};

                        for (const modalName of Object.keys(state.modals)) {
                            modals[modalName] = { data: undefined, isOpen: false };
                        }

                        return { modals };
                    });
                },
                closeModal: (modalName: string) => {
                    set((state) => {
                        return {
                            modals: {
                                ...state.modals,
                                [modalName]: { data: undefined, isOpen: false },
                            },
                        };
                    });
                },
                initializeSidebarStates: (sidebarNames: string[], defaultOpenState: "all" | string[]) => {
                    const defaultOpen = new Set(defaultOpenState === "all" ? sidebarNames : defaultOpenState);
                    const states: Record<string, SidebarStateValue> = {};

                    for (const name of sidebarNames) {
                        states[name] = { isMobileOpen: false, isOpen: defaultOpen.has(name) };
                    }

                    set({ sidebars: states });

                    return states;
                },
                openModal: (modalName: string, data?: unknown) => {
                    set((state) => {
                        return {
                            modals: {
                                ...state.modals,
                                [modalName]: { data, isOpen: true },
                            },
                        };
                    });
                },
                resetAppearance: () => {
                    set({ appearance: defaultUIState.appearance });
                },
                resetFonts: () => {
                    set({ fonts: defaultUIState.fonts });
                },
                resetKeyboardShortcuts: () => {
                    set({ keyboardShortcuts: defaultKeyboardShortcuts });
                },
                resetLayout: () => {
                    set({ layout: defaultUIState.layout });
                },
                resetSidebarStates: () => {
                    set({ sidebars: {} });
                },
                resetUIState: () => {
                    set(defaultUIState);
                },
                resetUserPreferences: () => {
                    set({ preferences: defaultUIState.preferences });
                },
                setAppearance: (appearance: Partial<AppearanceSettings>) => {
                    set((state) => {
                        return {
                            appearance: { ...state.appearance, ...appearance },
                        };
                    });
                },
                setFonts: (fonts: Partial<FontSettings>) => {
                    set((state) => {
                        return {
                            fonts: { ...state.fonts, ...fonts },
                        };
                    });
                },
                setKeyboardShortcuts: (shortcuts: Partial<KeyboardShortcuts>) => {
                    set((state) => {
                        return {
                            keyboardShortcuts: { ...state.keyboardShortcuts, ...shortcuts },
                        };
                    });
                },
                setLayoutState: (layout: Partial<LayoutState>) => {
                    set((state) => {
                        return {
                            layout: { ...state.layout, ...layout },
                        };
                    });
                },
                setModalState: (modalName: string, state: Partial<ModalState>) => {
                    set((currentState) => {
                        return {
                            modals: {
                                ...currentState.modals,
                                [modalName]: { ...(currentState.modals[modalName] || { isOpen: false }), ...state },
                            },
                        };
                    });
                },
                setRightSidebarWidth: (width: number) => {
                    set({ rightSidebarWidth: Math.min(RIGHT_SIDEBAR_MAX_WIDTH, Math.max(RIGHT_SIDEBAR_MIN_WIDTH, width)) });
                },
                setSearchState: (searchState: Partial<SearchState>) => {
                    set((state) => {
                        return {
                            search: { ...state.search, ...searchState },
                        };
                    });
                },
                setSidebarStates: (states: Record<string, SidebarStateValue>) => {
                    set((state) => {
                        return {
                            sidebars: { ...state.sidebars, ...states },
                        };
                    });
                },
                setUserPreferences: (preferences: Partial<UserPreferences>) => {
                    set((state) => {
                        return {
                            preferences: { ...state.preferences, ...preferences },
                        };
                    });
                },
                toggleSidebar: (sidebarName: string) => {
                    set((state) => {
                        const previous = state.sidebars[sidebarName] || { isMobileOpen: false, isOpen: false };

                        return {
                            sidebars: {
                                ...state.sidebars,
                                [sidebarName]: { ...previous, isOpen: !previous.isOpen },
                            },
                        };
                    });
                },
            };
        },
        {
            name: "neore-ui-state",
            partialize: (state) => {
                return {
                    appearance: state.appearance,
                    fonts: state.fonts,
                    keyboardShortcuts: state.keyboardShortcuts,
                    layout: state.layout,
                    modals: state.modals,
                    preferences: state.preferences,
                    rightSidebarWidth: state.rightSidebarWidth,
                    search: state.search,
                    sidebars: state.sidebars,
                };
            },
        },
    ),
);
