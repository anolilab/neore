"use client";

import { useMemo } from "react";

import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import type {
    AppearanceSettings,
    FontSettings,
    KeyboardShortcuts,
    LayoutState,
    SearchState,
    SidebarStateValue,
    UserPreferences,
} from "../stores/ui-state-store";
import { useUIStateStore } from "../stores/ui-state-store";

/**
 * The argument shape `updateUserSettings` actually accepts, taken from the
 * mutation instead of from `Partial<Doc<"userSettings">>`.
 *
 * The doc type is wider in both directions and neither gap is harmless: it
 * carries `_id` / `_creationTime` / `userId`, which the handler derives from the
 * caller's identity and the validator now rejects, and it widens every
 * `textEnum` column to `string` — so `codeFont: "whatever"` typechecked here and
 * failed at the boundary. Deriving it from `mutateAsync` keeps the two in step
 * by construction.
 */
type UserSettingsUpdate = Parameters<ReturnType<typeof useUpdateUserSettings>["mutateAsync"]>[0];

type SidebarsHookReturn = {
    resetSidebarStates: () => void;
    setSidebarStates: (states: Record<string, SidebarStateValue>) => void;
    sidebars: Record<string, SidebarStateValue>;
    toggleSidebar: (sidebarName: string) => void;
};

type SidebarHookReturn = {
    isMobileOpen: boolean;
    isOpen: boolean;
    setState: (state: Partial<SidebarStateValue>) => void;
    toggle: () => void;
};

type FontSettingsHookReturn = FontSettings & {
    resetFonts: () => void;
    setCodeFont: (codeFont: FontSettings["codeFont"]) => void;
    setFonts: (fonts: Partial<FontSettings>) => void;
    setMainFont: (mainFont: FontSettings["mainFont"]) => void;
};

type AppearanceSettingsHookReturn = AppearanceSettings & {
    resetAppearance: () => void;
    setAccentColor: (accentColor: AppearanceSettings["accentColor"]) => void;
    setCodeHighlightTheme: (codeHighlightTheme: AppearanceSettings["codeHighlightTheme"]) => void;
    setMermaidTheme: (mermaidTheme: AppearanceSettings["mermaidTheme"]) => void;
};

type SearchStateHookReturn = SearchState & {
    addRecentSearch: (query: string) => void;
    clearRecentSearches: () => void;
    closeSearch: () => void;
    openSearch: () => void;
    setQuery: (query: string) => void;
    setSearchState: (searchState: Partial<SearchState>) => void;
    setType: (type: SearchState["type"]) => void;
};

type ModalHookReturn = {
    close: () => void;
    data?: unknown;
    isOpen: boolean;
    open: (data?: unknown) => void;
    toggle: (data?: unknown) => void;
};

type ModalsHookReturn = {
    closeAllModals: () => void;
    closeModal: (modalName: string) => void;
    modals: Record<string, { data?: unknown; isOpen: boolean }>;
    openModal: (modalName: string, data?: unknown) => void;
    setModalState: (modalName: string, state: Partial<{ data?: unknown; isOpen: boolean }>) => void;
};

type LayoutStateHookReturn = LayoutState & {
    resetLayout: () => void;
    setDensity: (density: LayoutState["density"]) => void;
    setDirection: (direction: LayoutState["direction"]) => void;
    setFontSize: (fontSize: LayoutState["fontSize"]) => void;
    setLayoutState: (layout: Partial<LayoutState>) => void;
    setShowAvatars: (showAvatars: boolean) => void;
    setShowTimestamps: (showTimestamps: boolean) => void;
};

type UserPreferencesHookReturn = UserPreferences & {
    resetUserPreferences: () => void;
    setAnimations: (animations: boolean) => void;
    setAutoSave: (autoSave: boolean) => void;
    setDisableExternalLinkWarning: (disableExternalLinkWarning: boolean) => void;
    setHidePersonalInfo: (hidePersonalInfo: boolean) => void;
    setIsAdvancedUser: (isAdvancedUser: boolean) => void;
    setLastChatId: (lastChatId?: string) => void;
    setOnboardingCompleted: (onboardingCompleted: boolean) => void;
    setSendBehavior: (sendBehavior: UserPreferences["sendBehavior"]) => void;
    setShowTimestamps: (showTimestamps: boolean) => void;
    setSoundEffects: (soundEffects: boolean) => void;
    setTemporaryChatRetentionHours: (hours: number) => void;
    setUserPreferences: (preferences: Partial<UserPreferences>) => void;
    temporaryChatRetentionHours: number;
};

type KeyboardShortcutsHookReturn = {
    keyboardShortcuts: KeyboardShortcuts;
    resetKeyboardShortcuts: () => void;
    setArchiveThread: (shortcut: string) => void;
    setAudioRecord: (shortcut: string) => void;
    setCreateBranch: (shortcut: string) => void;
    setDeleteThread: (shortcut: string) => void;
    setEscape: (shortcut: string) => void;
    setHelp: (shortcut: string) => void;
    setKeyboardShortcuts: (shortcuts: Partial<KeyboardShortcuts>) => void;
    setNewChat: (shortcut: string) => void;
    setNewTemporaryChat: (shortcut: string) => void;
    setPinThread: (shortcut: string) => void;
    setSearch: (shortcut: string) => void;
    setShortcut: (key: keyof KeyboardShortcuts, shortcut: string) => void;
    setSidebarLeft: (shortcut: string) => void;
    setSidebarRight: (shortcut: string) => void;
};

export type UIStateHook = {
    actions: {
        addRecentSearch: (query: string) => void;
        clearRecentSearches: () => void;
        closeAllModals: () => void;
        closeModal: (modalName: string) => void;
        openModal: (modalName: string, data?: unknown) => void;
        resetFonts: () => void;
        resetKeyboardShortcuts: () => void;
        resetLayout: () => void;
        resetSidebarStates: () => void;
        resetUIState: () => void;
        resetUserPreferences: () => void;
        setFonts: (fonts: Partial<FontSettings>) => void;
        setKeyboardShortcuts: (shortcuts: Partial<KeyboardShortcuts>) => void;
        setLayoutState: (layout: Partial<LayoutState>) => void;
        setModalState: (modalName: string, state: Partial<{ data?: unknown; isOpen: boolean }>) => void;
        setSearchState: (searchState: Partial<SearchState>) => void;
        setSidebarStates: (states: Record<string, SidebarStateValue>) => void;
        setUserPreferences: (preferences: Partial<UserPreferences>) => void;
        toggleSidebar: (sidebarName: string) => void;
    };
    fonts: FontSettings;
    isLoading: boolean;
    keyboardShortcuts: KeyboardShortcuts;
    layout: LayoutState;
    modals: Record<string, { data?: unknown; isOpen: boolean }>;
    preferences: UserPreferences;
    search: SearchState;
    sidebars: Record<string, SidebarStateValue>;
    uiState?: {
        fonts: FontSettings;
        keyboardShortcuts: KeyboardShortcuts;
        layout: LayoutState;
        modals: Record<string, { data?: unknown; isOpen: boolean }>;
        preferences: UserPreferences;
        search: SearchState;
        sidebars: Record<string, SidebarStateValue>;
    };
};

/**
 * @deprecated Use specific selectors instead:
 * - useSidebarState(name) for sidebar state
 * - useFontSettings() for font settings
 * - useSearchState() for search state
 * - useModalState() or useModalState(name) for modals
 * - useLayoutState() for layout settings
 * - useUserPreferences() for user preferences
 * - useKeyboardShortcuts() for keyboard shortcuts
 *
 * This hook subscribes to the ENTIRE store and causes re-renders on ANY state change.
 * Use granular selectors for better performance.
 */
export const useUIState = (): UIStateHook => {
    const store = useUIStateStore();

    if (process.env.NODE_ENV === "development") {
        console.warn(
            "[PERFORMANCE] useUIState is deprecated and causes excessive re-renders.\n" +
                "Use specific selectors instead:\n" +
                "  - useSidebarState(name) for sidebar state\n" +
                "  - useFontSettings() for font settings\n" +
                "  - useSearchState() for search state\n" +
                "  - useModalState() or useModalState(name) for modals\n" +
                "  - useLayoutState() for layout settings\n" +
                "  - useUserPreferences() for user preferences\n" +
                "  - useKeyboardShortcuts() for keyboard shortcuts",
        );
    }

    return {
        actions: {
            addRecentSearch: store.addRecentSearch,
            clearRecentSearches: store.clearRecentSearches,
            closeAllModals: store.closeAllModals,
            closeModal: store.closeModal,
            openModal: store.openModal,
            resetFonts: store.resetFonts,
            resetKeyboardShortcuts: store.resetKeyboardShortcuts,
            resetLayout: store.resetLayout,
            resetSidebarStates: store.resetSidebarStates,
            resetUIState: store.resetUIState,
            resetUserPreferences: store.resetUserPreferences,
            setFonts: store.setFonts,
            setKeyboardShortcuts: store.setKeyboardShortcuts,
            setLayoutState: store.setLayoutState,
            setModalState: store.setModalState,
            setSearchState: store.setSearchState,
            setSidebarStates: store.setSidebarStates,
            setUserPreferences: store.setUserPreferences,
            toggleSidebar: store.toggleSidebar,
        },
        fonts: store.fonts,
        isLoading: false, // Zustand stores are always ready
        keyboardShortcuts: store.keyboardShortcuts,
        layout: store.layout,
        modals: store.modals,
        preferences: store.preferences,
        search: store.search,
        sidebars: store.sidebars,
        uiState: {
            fonts: store.fonts,
            keyboardShortcuts: store.keyboardShortcuts,
            layout: store.layout,
            modals: store.modals,
            preferences: store.preferences,
            search: store.search,
            sidebars: store.sidebars,
        },
    };
};

export function useSidebarState(): SidebarsHookReturn;
export function useSidebarState(sidebarName: string): SidebarHookReturn;
export function useSidebarState(sidebarName?: string): SidebarsHookReturn | SidebarHookReturn {
    // Use granular selectors to avoid subscribing to entire store
    const sidebars = useUIStateStore((state) => state.sidebars);
    const resetSidebarStates = useUIStateStore((state) => state.resetSidebarStates);
    const setSidebarStates = useUIStateStore((state) => state.setSidebarStates);
    const toggleSidebar = useUIStateStore((state) => state.toggleSidebar);

    if (sidebarName) {
        const sidebarState = sidebars[sidebarName] || { isMobileOpen: false, isOpen: false };

        return {
            ...sidebarState,
            setState: (state: Partial<SidebarStateValue>) => setSidebarStates({ [sidebarName]: { ...sidebarState, ...state } }),
            toggle: () => toggleSidebar(sidebarName),
        };
    }

    return {
        resetSidebarStates,
        setSidebarStates,
        sidebars,
        toggleSidebar,
    };
}

export const useFontSettings = (): FontSettingsHookReturn => {
    // Use granular selectors to avoid subscribing to entire store
    const fonts = useUIStateStore((state) => state.fonts);
    const resetFonts = useUIStateStore((state) => state.resetFonts);
    const setFonts = useUIStateStore((state) => state.setFonts);

    return {
        ...fonts,
        resetFonts,
        setCodeFont: (codeFont: FontSettings["codeFont"]) => setFonts({ codeFont }),
        setFonts,
        setMainFont: (mainFont: FontSettings["mainFont"]) => setFonts({ mainFont }),
    };
};

/**
 * Accent colour / code-highlight / Mermaid theme. The store (localStorage) is
 * what paints — the accent boot script reads it before hydration — and each
 * change is also written to `userSettings` so it follows the account to other
 * devices (`AppearanceSync` applies the stored row back).
 */
export const useAppearanceSettings = (): AppearanceSettingsHookReturn => {
    const appearance = useUIStateStore((state) => state.appearance);
    const resetAppearance = useUIStateStore((state) => state.resetAppearance);
    const setAppearance = useUIStateStore((state) => state.setAppearance);
    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    const userId = sessionData?.user?.id;
    const updateUserSettingsMutation = useUpdateUserSettings();

    const update = (changes: Partial<AppearanceSettings>) => {
        setAppearance(changes);

        if (userId) {
            // Local state already changed; a failed save only loses the cross-device copy.
            updateUserSettingsMutation.mutate(changes);
        }
    };

    return {
        ...appearance,
        resetAppearance,
        setAccentColor: (accentColor: AppearanceSettings["accentColor"]) => update({ accentColor }),
        setCodeHighlightTheme: (codeHighlightTheme: AppearanceSettings["codeHighlightTheme"]) => update({ codeHighlightTheme }),
        setMermaidTheme: (mermaidTheme: AppearanceSettings["mermaidTheme"]) => update({ mermaidTheme }),
    };
};

export const useSearchState = (): SearchStateHookReturn => {
    // Use granular selectors to avoid subscribing to entire store
    const search = useUIStateStore((state) => state.search);
    const addRecentSearch = useUIStateStore((state) => state.addRecentSearch);
    const clearRecentSearches = useUIStateStore((state) => state.clearRecentSearches);
    const setSearchState = useUIStateStore((state) => state.setSearchState);

    return {
        ...search,
        addRecentSearch,
        clearRecentSearches,
        closeSearch: () => setSearchState({ isOpen: false }),
        openSearch: () => setSearchState({ isOpen: true }),
        setQuery: (query: string) => setSearchState({ query }),
        setSearchState,
        setType: (type: SearchState["type"]) => setSearchState({ type }),
    };
};

export function useModalState(): ModalsHookReturn;
export function useModalState(modalName: string): ModalHookReturn;
export function useModalState(modalName?: string): ModalHookReturn | ModalsHookReturn {
    // Use granular selectors to avoid subscribing to entire store
    const modals = useUIStateStore((state) => state.modals);
    const closeAllModals = useUIStateStore((state) => state.closeAllModals);
    const closeModal = useUIStateStore((state) => state.closeModal);
    const openModal = useUIStateStore((state) => state.openModal);
    const setModalState = useUIStateStore((state) => state.setModalState);

    if (modalName) {
        const modalState = modals[modalName] || { isOpen: false };

        return {
            ...modalState,
            close: () => closeModal(modalName),
            open: (data?: unknown) => openModal(modalName, data),
            toggle: (data?: unknown) => {
                if (modalState.isOpen) {
                    closeModal(modalName);
                } else {
                    openModal(modalName, data);
                }
            },
        };
    }

    return {
        closeAllModals,
        closeModal,
        modals,
        openModal,
        setModalState,
    };
}

export const useLayoutState = (): LayoutStateHookReturn => {
    // Use granular selectors to avoid subscribing to entire store
    const layout = useUIStateStore((state) => state.layout);
    const resetLayout = useUIStateStore((state) => state.resetLayout);
    const setLayoutState = useUIStateStore((state) => state.setLayoutState);

    return {
        ...layout,
        resetLayout,
        setDensity: (density: LayoutState["density"]) => setLayoutState({ density }),
        setDirection: (direction: LayoutState["direction"]) => setLayoutState({ direction }),
        setFontSize: (fontSize: LayoutState["fontSize"]) => setLayoutState({ fontSize }),
        setLayoutState,
        setShowAvatars: (showAvatars: boolean) => setLayoutState({ showAvatars }),
        setShowTimestamps: (showTimestamps: boolean) => setLayoutState({ showTimestamps }),
    };
};

const SEND_BEHAVIORS = new Set<UserPreferences["sendBehavior"]>(["button", "enter", "shiftEnter"]);

const isSendBehavior = (value: unknown): value is UserPreferences["sendBehavior"] => SEND_BEHAVIORS.has(value as UserPreferences["sendBehavior"]);

export const useUserPreferences = (): UserPreferencesHookReturn => {
    // Use granular selectors to avoid subscribing to entire store
    const uiPreferences = useUIStateStore((state) => state.preferences);
    const resetUserPreferences = useUIStateStore((state) => state.resetUserPreferences);
    const setUserPreferencesAction = useUIStateStore((state) => state.setUserPreferences);

    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    const userId = sessionData?.user?.id;
    const { data: userSettings } = useUserSettings();
    const updateUserSettingsMutation = useUpdateUserSettings();

    // Merge Lunora-backed settings with UI state defaults
    const preferences = useMemo<UserPreferences>(() => {
        // The `userSettings.sendBehavior` column is a plain string server-side, so the
        // stored value is narrowed here rather than trusted; anything unrecognised falls
        // back to the UI-state default.
        const storedSendBehavior = userSettings?.sendBehavior;

        return {
            // Client-side preferences (from UI state)
            animations: uiPreferences.animations,
            autoSave: uiPreferences.autoSave,
            // Lunora-backed preferences (from userSettings query, fallback to UI state defaults)
            disableExternalLinkWarning: userSettings?.disableExternalLinkWarning ?? uiPreferences.disableExternalLinkWarning,
            hidePersonalInfo: userSettings?.hidePersonalInfo ?? uiPreferences.hidePersonalInfo,
            isAdvancedUser: userSettings?.isAdvancedUser ?? uiPreferences.isAdvancedUser,
            lastChatId: userSettings?.lastChatId ?? uiPreferences.lastChatId,
            onboardingCompleted: userSettings?.onboardingCompleted ?? uiPreferences.onboardingCompleted,
            sendBehavior: isSendBehavior(storedSendBehavior) ? storedSendBehavior : uiPreferences.sendBehavior,
            showTimestamps: uiPreferences.showTimestamps,
            soundEffects: uiPreferences.soundEffects,
        };
    }, [uiPreferences, userSettings]);

    // Helper to update userSettings via Lunora mutation
    const updateUserSettings = async (updates: UserSettingsUpdate) => {
        if (!userId) {
            return;
        }

        // Update via Lunora mutation (with optimistic updates)
        // userId is automatically set by the mutation handler
        await updateUserSettingsMutation.mutateAsync(updates);

        // Also update UI state for immediate feedback
        setUserPreferencesAction(updates as Partial<UserPreferences>);
    };

    return {
        ...preferences,
        resetUserPreferences,
        // Client-side preferences (only update UI state)
        setAnimations: (animations: boolean) => setUserPreferencesAction({ animations }),
        setAutoSave: (autoSave: boolean) => setUserPreferencesAction({ autoSave }),
        // Lunora-based preferences (update both collection and UI state)
        setDisableExternalLinkWarning: (disableExternalLinkWarning: boolean) => {
            updateUserSettings({ disableExternalLinkWarning });
        },
        setHidePersonalInfo: (hidePersonalInfo: boolean) => {
            updateUserSettings({ hidePersonalInfo });
        },
        setIsAdvancedUser: (isAdvancedUser: boolean) => {
            updateUserSettings({ isAdvancedUser });
        },
        setLastChatId: (lastChatId?: string) => {
            updateUserSettings({ lastChatId });
        },
        setOnboardingCompleted: (onboardingCompleted: boolean) => {
            updateUserSettings({ onboardingCompleted });
        },
        setSendBehavior: (sendBehavior: UserPreferences["sendBehavior"]) => {
            updateUserSettings({ sendBehavior });
        },
        setShowTimestamps: (showTimestamps: boolean) => setUserPreferencesAction({ showTimestamps }),
        setSoundEffects: (soundEffects: boolean) => setUserPreferencesAction({ soundEffects }),
        setTemporaryChatRetentionHours: (hours: number) => {
            updateUserSettings({ temporaryChatRetentionHours: hours });
        },
        setUserPreferences: (prefs: Partial<UserPreferences>) => {
            // Split into client-side and Lunora-backed
            const clientSide: Partial<UserPreferences> = {};
            const serverBacked: UserSettingsUpdate = {};

            if ("animations" in prefs) {
                clientSide.animations = prefs.animations;
            }

            if ("autoSave" in prefs) {
                clientSide.autoSave = prefs.autoSave;
            }

            if ("showTimestamps" in prefs) {
                clientSide.showTimestamps = prefs.showTimestamps;
            }

            if ("soundEffects" in prefs) {
                clientSide.soundEffects = prefs.soundEffects;
            }

            if ("disableExternalLinkWarning" in prefs) {
                serverBacked.disableExternalLinkWarning = prefs.disableExternalLinkWarning;
            }

            if ("hidePersonalInfo" in prefs) {
                serverBacked.hidePersonalInfo = prefs.hidePersonalInfo;
            }

            if ("isAdvancedUser" in prefs) {
                serverBacked.isAdvancedUser = prefs.isAdvancedUser;
            }

            if ("lastChatId" in prefs) {
                serverBacked.lastChatId = prefs.lastChatId;
            }

            if ("onboardingCompleted" in prefs) {
                serverBacked.onboardingCompleted = prefs.onboardingCompleted;
            }

            if ("sendBehavior" in prefs) {
                serverBacked.sendBehavior = prefs.sendBehavior;
            }

            if (Object.keys(clientSide).length > 0) {
                setUserPreferencesAction(clientSide);
            }

            if (Object.keys(serverBacked).length > 0) {
                updateUserSettings(serverBacked);
            }
        },
        temporaryChatRetentionHours: userSettings?.temporaryChatRetentionHours ?? 24,
    };
};

export const useKeyboardShortcuts = (): KeyboardShortcutsHookReturn => {
    // Use granular selectors to avoid subscribing to entire store
    const keyboardShortcuts = useUIStateStore((state) => state.keyboardShortcuts);
    const resetKeyboardShortcuts = useUIStateStore((state) => state.resetKeyboardShortcuts);
    const setKeyboardShortcuts = useUIStateStore((state) => state.setKeyboardShortcuts);

    return {
        keyboardShortcuts,
        resetKeyboardShortcuts,
        setArchiveThread: (shortcut: string) => setKeyboardShortcuts({ archiveThread: shortcut }),
        setAudioRecord: (shortcut: string) => setKeyboardShortcuts({ audioRecord: shortcut }),
        setCreateBranch: (shortcut: string) => setKeyboardShortcuts({ createBranch: shortcut }),
        setDeleteThread: (shortcut: string) => setKeyboardShortcuts({ deleteThread: shortcut }),
        setEscape: (shortcut: string) => setKeyboardShortcuts({ escape: shortcut }),
        setHelp: (shortcut: string) => setKeyboardShortcuts({ help: shortcut }),
        setKeyboardShortcuts,
        setNewChat: (shortcut: string) => setKeyboardShortcuts({ newChat: shortcut }),
        setNewTemporaryChat: (shortcut: string) => setKeyboardShortcuts({ newTemporaryChat: shortcut }),
        setPinThread: (shortcut: string) => setKeyboardShortcuts({ pinThread: shortcut }),
        setSearch: (shortcut: string) => setKeyboardShortcuts({ search: shortcut }),
        setShortcut: (key: keyof KeyboardShortcuts, shortcut: string) => setKeyboardShortcuts({ [key]: shortcut }),
        // Specific shortcut setters
        setSidebarLeft: (shortcut: string) => setKeyboardShortcuts({ sidebarLeft: shortcut }),
        setSidebarRight: (shortcut: string) => setKeyboardShortcuts({ sidebarRight: shortcut }),
    };
};

export const useUIStateReady = (): boolean =>
    // Zustand stores are always ready (no loading state)
    true;
