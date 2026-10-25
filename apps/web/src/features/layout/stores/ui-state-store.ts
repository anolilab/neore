"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AccentId } from "@/features/appearance/lib/accent-presets";
import type { CodeHighlightThemeId, MermaidThemeId } from "@/features/appearance/lib/code-themes";
import type { ContrastId, DensityId, MainFontId } from "@/features/appearance/lib/display-preferences";

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
};

/** Accent colour, code-block and diagram themes, UI density and font family — see `features/appearance`. */
export type AppearanceSettings = {
    accentColor: AccentId;
    /** Absent means on: long code blocks scroll inside a 24-line cap until expanded. */
    capLongCodeBlocks?: boolean;
    codeHighlightTheme: CodeHighlightThemeId;
    /** Absent means off. */
    codeLineNumbers?: boolean;
    /** Absent means `system`: follow the OS `prefers-contrast: more` setting. */
    contrast?: ContrastId;
    density: DensityId;
    mainFont: MainFontId;
    mermaidTheme: MermaidThemeId;
};

export type KeyboardShortcuts = {
    audioRecord: string;
    commandPalette: string;
    copyLastCodeBlock: string;
    escape: string;
    firstItem: string;
    focusSearch: string;
    help: string;
    lastItem: string;
    newChat: string;
    newTemporaryChat: string;
    nextItem: string;
    openModelPicker: string;
    prevItem: string;
    sidebarLeft: string;
    sidebarRight: string;
};

export type Direction = "ltr" | "rtl";

export type LayoutState = {
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

/** What "Reset to Defaults" restores. */
export const defaultKeyboardShortcuts: KeyboardShortcuts = {
    audioRecord: `${platformModifier}+shift+r`,
    commandPalette: `${platformModifier}+k`,
    copyLastCodeBlock: `${platformModifier}+shift+x`,
    escape: "escape",
    firstItem: "home",
    focusSearch: `${platformModifier}+f`,
    help: `${platformModifier}+/`,
    lastItem: "end",
    newChat: `${platformModifier}+n`,
    newTemporaryChat: `${platformModifier}+shift+n`,
    nextItem: "arrowdown",
    openModelPicker: `${platformModifier}+shift+m`,
    prevItem: "arrowup",
    sidebarLeft: `${platformModifier}+b`,
    sidebarRight: `${platformModifier}+shift+b`,
};

const RIGHT_SIDEBAR_DEFAULT_WIDTH = 280;

export const RIGHT_SIDEBAR_MIN_WIDTH = 240;
export const RIGHT_SIDEBAR_MAX_WIDTH = 600;

const defaultUIState = {
    appearance: {
        accentColor: "default",
        capLongCodeBlocks: true,
        codeHighlightTheme: "default",
        codeLineNumbers: false,
        density: "comfortable",
        mainFont: "inter",
        mermaidTheme: "default",
    } as AppearanceSettings,
    fonts: { codeFont: "fira-code" as const },
    keyboardShortcuts: defaultKeyboardShortcuts,
    layout: { direction: "ltr" as const, fontSize: "medium" as const, showAvatars: true, showTimestamps: true },
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
            // The persisted object replaces the defaults wholesale, so a key added after a
            // user last saved (a new shortcut, a new appearance flag) would be missing.
            merge: (persisted, current) => {
                const saved = (persisted ?? {}) as Partial<typeof current>;

                return {
                    ...current,
                    ...saved,
                    appearance: { ...current.appearance, ...saved.appearance },
                    keyboardShortcuts: { ...current.keyboardShortcuts, ...saved.keyboardShortcuts },
                };
            },
            partialize: (state) => {
                return {
                    appearance: state.appearance,
                    fonts: state.fonts,
                    keyboardShortcuts: state.keyboardShortcuts,
                    layout: state.layout,
                    preferences: state.preferences,
                    rightSidebarWidth: state.rightSidebarWidth,
                    search: state.search,
                    sidebars: state.sidebars,
                };
            },
        },
    ),
);
