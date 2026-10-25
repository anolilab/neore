import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { HotkeysProvider, useHotkeys } from "react-hotkeys-hook";

import { useKeyboardShortcuts as useUIKeyboardShortcuts } from "@/features/layout/hooks/use-ui-state";
import type { KeyboardShortcuts } from "@/features/layout/stores/ui-state-store";

import { convertRecordedShortcutToHotkeysHook } from "../lib/recorded-shortcut-converter";
import convertShortcutToHotkeysHook from "../lib/shortcut-converter";
import { hasThreadSearchTarget } from "../lib/thread-search-target";

// Context for keyboard shortcuts
interface KeyboardShortcutsContextType {
    shortcuts: KeyboardShortcuts;
    updateShortcuts: (shortcuts: Partial<KeyboardShortcuts>) => void;
}

const KeyboardShortcutsContext = React.createContext<KeyboardShortcutsContextType | undefined>(undefined);

// Helper to check if user is typing in an input - prevents interference with single-letter shortcuts
const isUserTypingInInput = (event: KeyboardEvent): boolean => {
    const target = event.target as HTMLElement | null;
    const activeElement = document.activeElement as HTMLElement | null;

    return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true ||
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement?.isContentEditable === true ||
        !!target?.closest("input, textarea, [contenteditable], [data-composer-input]") ||
        !!activeElement?.closest("input, textarea, [contenteditable], [data-composer-input]")
    );
};

// A key with no ctrl/meta/alt (a bare letter, or shift alone) types a character into an
// editable target. Such a keystroke belongs to the field, so the shortcut must not take it.
const isTextEntryKeystroke = (event: KeyboardEvent): boolean => isUserTypingInInput(event) && !event.ctrlKey && !event.metaKey && !event.altKey;

const isBound = (shortcut: string | undefined): boolean => typeof shortcut === "string" && shortcut !== "";

/** Bound, and on a different chord than `other`: a chord shared by two commands would run both on one press. */
const isBoundApart = (shortcut: string | undefined, converted: string, other: string): boolean => isBound(shortcut) && converted !== other;

// The effort commands are bound with modifier chords that work from the composer; a bare key stays with the field.
const createEffortHandler =
    (command: "decreaseEffort" | "increaseEffort", onShortcut?: (action: keyof KeyboardShortcutsConfig, event: KeyboardEvent) => void) =>
    (event: KeyboardEvent): void => {
        if (isTextEntryKeystroke(event)) {
            return;
        }

        event.preventDefault();
        onShortcut?.(command, event);
    };

// Internal component that registers hotkeys
const KeyboardShortcutsHandler: React.FC<{
    onShortcut?: (action: keyof KeyboardShortcutsConfig, event: KeyboardEvent) => void;
    shortcuts: KeyboardShortcuts;
}> = ({ onShortcut, shortcuts }) => {
    // Track if component is mounted using a ref to prevent state updates during unmount

    // Check if we're in an input - use a ref to track this without causing re-renders.
    // Declared up here because the shortcut callbacks below close over it.
    const isInInputRef = useRef(false);

    // Memoize converted shortcuts to prevent unnecessary re-registrations
    const convertedShortcuts = useMemo(() => {
        return {
            audioRecord: convertShortcutToHotkeysHook(shortcuts.audioRecord),
            copyLastCodeBlock: convertShortcutToHotkeysHook(shortcuts.copyLastCodeBlock),
            decreaseEffort: convertRecordedShortcutToHotkeysHook(shortcuts.decreaseEffort),
            escape: convertShortcutToHotkeysHook(shortcuts.escape),
            firstItem: convertShortcutToHotkeysHook(shortcuts.firstItem),
            focusSearch: convertShortcutToHotkeysHook(shortcuts.focusSearch),
            help: convertShortcutToHotkeysHook(shortcuts.help),
            increaseEffort: convertRecordedShortcutToHotkeysHook(shortcuts.increaseEffort),
            lastItem: convertShortcutToHotkeysHook(shortcuts.lastItem),
            newChat: convertShortcutToHotkeysHook(shortcuts.newChat),
            newTemporaryChat: convertShortcutToHotkeysHook(shortcuts.newTemporaryChat),
            nextItem: convertShortcutToHotkeysHook(shortcuts.nextItem),
            openModelPicker: convertShortcutToHotkeysHook(shortcuts.openModelPicker),
            prevItem: convertShortcutToHotkeysHook(shortcuts.prevItem),
            sidebarLeft: convertShortcutToHotkeysHook(shortcuts.sidebarLeft),
            sidebarRight: convertShortcutToHotkeysHook(shortcuts.sidebarRight),
        };
    }, [
        shortcuts.audioRecord,
        shortcuts.copyLastCodeBlock,
        shortcuts.decreaseEffort,
        shortcuts.escape,
        shortcuts.firstItem,
        shortcuts.focusSearch,
        shortcuts.help,
        shortcuts.increaseEffort,
        shortcuts.lastItem,
        shortcuts.newChat,
        shortcuts.newTemporaryChat,
        shortcuts.nextItem,
        shortcuts.openModelPicker,
        shortcuts.prevItem,
        shortcuts.sidebarLeft,
        shortcuts.sidebarRight,
    ]);

    // Memoize each callback individually to prevent infinite re-renders
    const handleAudioRecord = useCallback(
        (event: KeyboardEvent) => {
            event.preventDefault();
            onShortcut?.("audioRecord", event);
        },
        [onShortcut],
    );

    const handleCopyLastCodeBlock = useCallback(
        (event: KeyboardEvent) => {
            if (isTextEntryKeystroke(event)) {
                return;
            }

            event.preventDefault();
            onShortcut?.("copyLastCodeBlock", event);
        },
        [onShortcut],
    );

    const handleEscape = useCallback(
        (event: KeyboardEvent) => {
            event.preventDefault();
            onShortcut?.("escape", event);
        },
        [onShortcut],
    );

    const handleFirstItem = useCallback(
        (event: KeyboardEvent) => {
            event.preventDefault();
            onShortcut?.("firstItem", event);
        },
        [onShortcut],
    );

    const handleFocusSearch = useCallback(
        (event: KeyboardEvent) => {
            // Without a search to focus the keystroke belongs to the browser's find.
            if (!hasThreadSearchTarget()) {
                return;
            }

            event.preventDefault();
            onShortcut?.("focusSearch", event);
        },
        [onShortcut],
    );

    const handleHelp = useCallback(
        (event: KeyboardEvent) => {
            event.preventDefault();
            onShortcut?.("help", event);
        },
        [onShortcut],
    );

    const handleDecreaseEffort = useMemo(() => createEffortHandler("decreaseEffort", onShortcut), [onShortcut]);
    const handleIncreaseEffort = useMemo(() => createEffortHandler("increaseEffort", onShortcut), [onShortcut]);

    const handleLastItem = useCallback(
        (event: KeyboardEvent) => {
            event.preventDefault();
            onShortcut?.("lastItem", event);
        },
        [onShortcut],
    );

    const handleNewChat = useCallback(
        (event: KeyboardEvent) => {
            event.preventDefault();
            onShortcut?.("newChat", event);
        },
        [onShortcut],
    );

    const handleNewTemporaryChat = useCallback(
        (event: KeyboardEvent) => {
            event.preventDefault();
            onShortcut?.("newTemporaryChat", event);
        },
        [onShortcut],
    );

    const handleNextItem = useCallback(
        (event: KeyboardEvent) => {
            event.preventDefault();
            onShortcut?.("nextItem", event);
        },
        [onShortcut],
    );

    const handleOpenModelPicker = useCallback(
        (event: KeyboardEvent) => {
            if (isTextEntryKeystroke(event)) {
                return;
            }

            event.preventDefault();
            onShortcut?.("openModelPicker", event);
        },
        [onShortcut],
    );

    const handlePreviousItem = useCallback(
        (event: KeyboardEvent) => {
            event.preventDefault();
            onShortcut?.("prevItem", event);
        },
        [onShortcut],
    );

    const handleSidebarLeft = useCallback(
        (event: KeyboardEvent) => {
            // Double-check we're not in an input - react-hotkeys-hook should handle this, but be extra safe
            // This is critical for single-letter shortcuts (like "b" for sidebarLeft) that users might customize
            // Check both the ref (for performance) and the event (for accuracy)
            if (isInInputRef.current || isUserTypingInInput(event)) {
                // Don't interfere with typing
                return;
            }

            event.preventDefault();
            onShortcut?.("sidebarLeft", event);
        },
        [onShortcut],
    );

    const handleSidebarRight = useCallback(
        (event: KeyboardEvent) => {
            // Double-check we're not in an input - protects against single-letter shortcuts
            // Check both the ref (for performance) and the event (for accuracy)
            if (isInInputRef.current || isUserTypingInInput(event)) {
                return;
            }

            event.preventDefault();
            onShortcut?.("sidebarRight", event);
        },
        [onShortcut],
    );

    // Register all shortcuts - only enable if shortcut exists and component is mounted
    useHotkeys(
        convertedShortcuts.audioRecord,
        handleAudioRecord,
        {
            description: "Toggle audio recording",
            enabled: !!shortcuts.audioRecord && typeof shortcuts.audioRecord === "string",
            enableOnContentEditable: false,
            enableOnFormTags: false,
            preventDefault: true,
        },
        [convertedShortcuts.audioRecord, handleAudioRecord],
    );

    useHotkeys(
        convertedShortcuts.copyLastCodeBlock,
        handleCopyLastCodeBlock,
        {
            description: "Copy last code block",
            enabled: !!shortcuts.copyLastCodeBlock && typeof shortcuts.copyLastCodeBlock === "string",
            // Enabled in fields so a modifier chord works from the composer. The predicate keeps
            // a bare key from being prevented there, since react-hotkeys-hook prevents by itself.
            enableOnContentEditable: true,
            enableOnFormTags: true,
            preventDefault: (event: KeyboardEvent) => !isTextEntryKeystroke(event),
        },
        [convertedShortcuts.copyLastCodeBlock, handleCopyLastCodeBlock],
    );

    useHotkeys(
        convertedShortcuts.escape,
        handleEscape,
        {
            description: "Escape/Close",
            enabled: !!shortcuts.escape && typeof shortcuts.escape === "string",
            enableOnContentEditable: false,
            enableOnFormTags: false,
            preventDefault: true,
        },
        [convertedShortcuts.escape, handleEscape],
    );

    useHotkeys(
        convertedShortcuts.firstItem,
        handleFirstItem,
        {
            description: "Navigate to first item",
            enabled: !!shortcuts.firstItem && typeof shortcuts.firstItem === "string",
            enableOnContentEditable: false,
            enableOnFormTags: false,
            preventDefault: true,
        },
        [convertedShortcuts.firstItem, handleFirstItem],
    );

    useHotkeys(
        convertedShortcuts.focusSearch,
        handleFocusSearch,
        {
            description: "Focus search",
            enabled: !!shortcuts.focusSearch && typeof shortcuts.focusSearch === "string",
            enableOnContentEditable: false,
            enableOnFormTags: false,
            preventDefault: hasThreadSearchTarget,
        },
        [convertedShortcuts.focusSearch, handleFocusSearch],
    );

    useHotkeys(
        convertedShortcuts.help,
        handleHelp,
        {
            description: "Show help",
            enabled: !!shortcuts.help && typeof shortcuts.help === "string",
            enableOnContentEditable: false,
            enableOnFormTags: false,
            preventDefault: true,
        },
        [convertedShortcuts.help, handleHelp],
    );

    useHotkeys(
        convertedShortcuts.lastItem,
        handleLastItem,
        {
            description: "Navigate to last item",
            enabled: !!shortcuts.lastItem && typeof shortcuts.lastItem === "string",
            enableOnContentEditable: false,
            enableOnFormTags: false,
            preventDefault: true,
        },
        [convertedShortcuts.lastItem, handleLastItem],
    );

    useHotkeys(
        convertedShortcuts.newChat,
        handleNewChat,
        {
            description: "New chat",
            enabled: !!shortcuts.newChat && typeof shortcuts.newChat === "string",
            enableOnContentEditable: false,
            enableOnFormTags: false,
            preventDefault: true,
        },
        [convertedShortcuts.newChat, handleNewChat],
    );

    useHotkeys(
        convertedShortcuts.newTemporaryChat,
        handleNewTemporaryChat,
        {
            description: "New temporary chat",
            enabled: !!shortcuts.newTemporaryChat && typeof shortcuts.newTemporaryChat === "string",
            enableOnContentEditable: false,
            enableOnFormTags: false,
            preventDefault: true,
        },
        [convertedShortcuts.newTemporaryChat, handleNewTemporaryChat],
    );

    useHotkeys(
        convertedShortcuts.decreaseEffort,
        handleDecreaseEffort,
        {
            description: "Decrease the composer's reasoning effort",
            enabled: isBound(shortcuts.decreaseEffort),
            // Like the model picker: a modifier chord must work from the composer, a bare key must not be taken from a field.
            enableOnContentEditable: true,
            enableOnFormTags: true,
            preventDefault: (event: KeyboardEvent) => !isTextEntryKeystroke(event),
        },
        [convertedShortcuts.decreaseEffort, handleDecreaseEffort],
    );

    useHotkeys(
        convertedShortcuts.increaseEffort,
        handleIncreaseEffort,
        {
            description: "Increase the composer's reasoning effort",
            // Saved bindings can reach us from elsewhere than the settings form: one chord must not step both ways.
            enabled: isBoundApart(shortcuts.increaseEffort, convertedShortcuts.increaseEffort, convertedShortcuts.decreaseEffort),
            enableOnContentEditable: true,
            enableOnFormTags: true,
            preventDefault: (event: KeyboardEvent) => !isTextEntryKeystroke(event),
        },
        [convertedShortcuts.increaseEffort, handleIncreaseEffort],
    );

    useHotkeys(
        convertedShortcuts.nextItem,
        handleNextItem,
        {
            description: "Navigate to next item",
            enabled: !!shortcuts.nextItem && typeof shortcuts.nextItem === "string",
            enableOnContentEditable: false,
            enableOnFormTags: false,
            preventDefault: true,
        },
        [convertedShortcuts.nextItem, handleNextItem],
    );

    useHotkeys(
        convertedShortcuts.openModelPicker,
        handleOpenModelPicker,
        {
            description: "Open the model picker",
            enabled: !!shortcuts.openModelPicker && typeof shortcuts.openModelPicker === "string",
            // Like the copy shortcut: a modifier chord must work from the composer, a bare key must not be taken from a field.
            enableOnContentEditable: true,
            enableOnFormTags: true,
            preventDefault: (event: KeyboardEvent) => !isTextEntryKeystroke(event),
        },
        [convertedShortcuts.openModelPicker, handleOpenModelPicker],
    );

    useHotkeys(
        convertedShortcuts.prevItem,
        handlePreviousItem,
        {
            description: "Navigate to previous item",
            enabled: !!shortcuts.prevItem && typeof shortcuts.prevItem === "string",
            enableOnContentEditable: false,
            enableOnFormTags: false,
            preventDefault: true,
        },
        [convertedShortcuts.prevItem, handlePreviousItem],
    );

    useEffect(() => {
        const checkInputFocus = () => {
            const activeElement = document.activeElement as HTMLElement | null;

            isInInputRef.current =
                activeElement instanceof HTMLInputElement ||
                activeElement instanceof HTMLTextAreaElement ||
                activeElement?.isContentEditable === true ||
                !!activeElement?.closest("input, textarea, [contenteditable], [data-composer-input]");
        };

        // Check on focus/blur events
        document.addEventListener("focusin", checkInputFocus, { capture: true });
        document.addEventListener("focusout", checkInputFocus, { capture: true });

        // Initial check - use setTimeout to avoid state updates during render
        const initialCheckTimeout = setTimeout(checkInputFocus, 0);

        return () => {
            clearTimeout(initialCheckTimeout);
            document.removeEventListener("focusin", checkInputFocus, true);
            document.removeEventListener("focusout", checkInputFocus, true);
        };
    }, []);

    useHotkeys(
        convertedShortcuts.sidebarLeft,
        handleSidebarLeft,
        {
            description: "Toggle left sidebar",
            enabled: !!shortcuts.sidebarLeft && typeof shortcuts.sidebarLeft === "string",
            enableOnContentEditable: false,
            enableOnFormTags: false,
            preventDefault: true,
        },
        [convertedShortcuts.sidebarLeft, handleSidebarLeft],
    );

    useHotkeys(
        convertedShortcuts.sidebarRight,
        handleSidebarRight,
        {
            description: "Toggle right sidebar",
            enabled: !!shortcuts.sidebarRight && typeof shortcuts.sidebarRight === "string",
            enableOnContentEditable: false,
            enableOnFormTags: false,
            preventDefault: true,
        },
        [convertedShortcuts.sidebarRight, handleSidebarRight],
    );

    return null;
};

export const KeyboardShortcutsManager: React.FC<{
    children: React.ReactNode;
    onShortcut?: (action: keyof KeyboardShortcutsConfig, event: KeyboardEvent) => void;
    shortcuts?: Partial<KeyboardShortcutsConfig>;
}> = ({ children, onShortcut, shortcuts: propertyShortcuts }) => {
    // Get keyboard shortcuts from UI state collection
    const uiKeyboardShortcuts = useUIKeyboardShortcuts();

    // Merge user settings with prop overrides
    const effectiveShortcuts = useMemo(() => {
        return {
            ...uiKeyboardShortcuts.keyboardShortcuts,
            ...propertyShortcuts,
        };
    }, [uiKeyboardShortcuts.keyboardShortcuts, propertyShortcuts]);

    // Update shortcuts using UI state collection
    const updateShortcuts = useCallback(
        (newShortcuts: Partial<KeyboardShortcutsConfig>) => {
            uiKeyboardShortcuts.setKeyboardShortcuts(newShortcuts);
        },
        [uiKeyboardShortcuts],
    );

    // Context value for child components
    const contextValue = useMemo(() => {
        return {
            shortcuts: effectiveShortcuts,
            updateShortcuts,
        };
    }, [effectiveShortcuts, updateShortcuts]);

    return (
        <HotkeysProvider>
            <KeyboardShortcutsContext value={contextValue}>
                <KeyboardShortcutsHandler onShortcut={onShortcut} shortcuts={effectiveShortcuts} />
                {children}
            </KeyboardShortcutsContext>
        </HotkeysProvider>
    );
};

export const useKeyboardShortcuts = (): KeyboardShortcutsContextType => {
    const context = React.use(KeyboardShortcutsContext);

    if (!context) {
        throw new Error("useKeyboardShortcuts must be used within KeyboardShortcutsManager");
    }

    return context;
};

// Hook for specific shortcut actions
export const useShortcut = (action: keyof KeyboardShortcutsConfig): string | undefined => {
    const { shortcuts } = useKeyboardShortcuts();
    const shortcutValue = shortcuts[action];

    // Filter out function properties and return only string shortcuts
    return typeof shortcutValue === "string" ? shortcutValue : undefined;
};

export type KeyboardShortcutsConfig = KeyboardShortcuts;
