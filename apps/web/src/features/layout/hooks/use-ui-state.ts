"use client";

import { useMemo } from "react";

import type { ContrastId } from "@/features/appearance/lib/display-preferences";
import { DEFAULT_CONTRAST, DEFAULT_DENSITY, DEFAULT_MAIN_FONT, isContrastId, isDensityId, isMainFontId } from "@/features/appearance/lib/display-preferences";
import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import type { AppearanceSettings, KeyboardShortcuts, LayoutState, SearchState, SidebarStateValue, UserPreferences } from "../stores/ui-state-store";
import { useUIStateStore } from "../stores/ui-state-store";

/**
 * The argument shape `updateUserSettings` actually accepts, taken from the
 * mutation instead of from `Partial<Doc<"userSettings">>`.
 *
 * The doc type is wider in both directions and neither gap is harmless: it
 * carries `_id` / `_creationTime` / `userId`, which the handler derives from the
 * caller's identity and the validator now rejects, and it widens every
 * `textEnum` column to `string` — so `sendBehavior: "whatever"` typechecked here and
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

type AppearanceSettingsHookReturn = AppearanceSettings & {
    resetAppearance: () => void;
    setAccentColor: (accentColor: AppearanceSettings["accentColor"]) => void;
    setCapLongCodeBlocks: (capLongCodeBlocks: boolean) => void;
    setCodeHighlightTheme: (codeHighlightTheme: AppearanceSettings["codeHighlightTheme"]) => void;
    setCodeLineNumbers: (codeLineNumbers: boolean) => void;
    setContrast: (contrast: ContrastId) => void;
    setDensity: (density: AppearanceSettings["density"]) => void;
    setMainFont: (mainFont: AppearanceSettings["mainFont"]) => void;
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
    setDirection: (direction: LayoutState["direction"]) => void;
    setFontSize: (fontSize: LayoutState["fontSize"]) => void;
    setLayoutState: (layout: Partial<LayoutState>) => void;
    setShowAvatars: (showAvatars: boolean) => void;
    setShowTimestamps: (showTimestamps: boolean) => void;
};

type UserPreferencesHookReturn = UserPreferences & {
    resetUserPreferences: () => void;
    setHidePersonalInfo: (hidePersonalInfo: boolean) => void;
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
    setAudioRecord: (shortcut: string) => void;
    setEscape: (shortcut: string) => void;
    setHelp: (shortcut: string) => void;
    setKeyboardShortcuts: (shortcuts: Partial<KeyboardShortcuts>) => void;
    setNewChat: (shortcut: string) => void;
    setNewTemporaryChat: (shortcut: string) => void;
    setShortcut: (key: keyof KeyboardShortcuts, shortcut: string) => void;
    setSidebarLeft: (shortcut: string) => void;
    setSidebarRight: (shortcut: string) => void;
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
        // Persisted state from before density and font existed has neither key (zustand merges shallowly), so read them through the guards.
        contrast: isContrastId(appearance.contrast) ? appearance.contrast : DEFAULT_CONTRAST,
        density: isDensityId(appearance.density) ? appearance.density : DEFAULT_DENSITY,
        mainFont: isMainFontId(appearance.mainFont) ? appearance.mainFont : DEFAULT_MAIN_FONT,
        resetAppearance,
        setAccentColor: (accentColor: AppearanceSettings["accentColor"]) => update({ accentColor }),
        setCapLongCodeBlocks: (capLongCodeBlocks: boolean) => update({ capLongCodeBlocks }),
        setCodeHighlightTheme: (codeHighlightTheme: AppearanceSettings["codeHighlightTheme"]) => update({ codeHighlightTheme }),
        setCodeLineNumbers: (codeLineNumbers: boolean) => update({ codeLineNumbers }),
        setContrast: (contrast: ContrastId) => update({ contrast }),
        setDensity: (density: AppearanceSettings["density"]) => update({ density }),
        setMainFont: (mainFont: AppearanceSettings["mainFont"]) => update({ mainFont }),
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
            // Lunora-backed preferences (from userSettings query, fallback to UI state defaults)
            hidePersonalInfo: userSettings?.hidePersonalInfo ?? uiPreferences.hidePersonalInfo,
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
        // Lunora-based preferences (update both collection and UI state)
        setHidePersonalInfo: (hidePersonalInfo: boolean) => {
            updateUserSettings({ hidePersonalInfo });
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

            if ("showTimestamps" in prefs) {
                clientSide.showTimestamps = prefs.showTimestamps;
            }

            if ("soundEffects" in prefs) {
                clientSide.soundEffects = prefs.soundEffects;
            }

            if ("hidePersonalInfo" in prefs) {
                serverBacked.hidePersonalInfo = prefs.hidePersonalInfo;
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
        setAudioRecord: (shortcut: string) => setKeyboardShortcuts({ audioRecord: shortcut }),
        setEscape: (shortcut: string) => setKeyboardShortcuts({ escape: shortcut }),
        setHelp: (shortcut: string) => setKeyboardShortcuts({ help: shortcut }),
        setKeyboardShortcuts,
        setNewChat: (shortcut: string) => setKeyboardShortcuts({ newChat: shortcut }),
        setNewTemporaryChat: (shortcut: string) => setKeyboardShortcuts({ newTemporaryChat: shortcut }),
        setShortcut: (key: keyof KeyboardShortcuts, shortcut: string) => setKeyboardShortcuts({ [key]: shortcut }),
        // Specific shortcut setters
        setSidebarLeft: (shortcut: string) => setKeyboardShortcuts({ sidebarLeft: shortcut }),
        setSidebarRight: (shortcut: string) => setKeyboardShortcuts({ sidebarRight: shortcut }),
    };
};

export const useUIStateReady = (): boolean =>
    // Zustand stores are always ready (no loading state)
    true;
