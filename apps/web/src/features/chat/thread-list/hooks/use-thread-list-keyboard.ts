import { useEffect, useEffectEvent } from "react";

/** How long after the ContextMenu key a browser's own `contextmenu` event is still swallowed. */
const CONTEXT_MENU_KEY_WINDOW_MS = 500;

/**
 * Windows fires a `contextmenu` event after the ContextMenu key's keydown, and cancelling the keydown does not stop it: the
 * browser's own menu would open over the options menu. That event is cancelled when it targets the same element as the key.
 * A pointer press ends the window first, so a real right-click is never cancelled.
 */
const suppressNextContextMenu = (keyTarget: EventTarget | null): void => {
    const controller = new AbortController();
    const { signal } = controller;

    document.addEventListener(
        "contextmenu",
        (event) => {
            if (event.target === keyTarget) {
                event.preventDefault();
            }

            controller.abort();
        },
        { capture: true, once: true, signal },
    );
    document.addEventListener(
        "pointerdown",
        () => {
            controller.abort();
        },
        { capture: true, once: true, signal },
    );
    globalThis.setTimeout(() => {
        controller.abort();
    }, CONTEXT_MENU_KEY_WINDOW_MS);
};

/**
 * Whether the keys act on the remembered selection: focus is in the sidebar, or on nothing. Once F6 moves focus into the thread,
 * the composer or the right panel, the selection stays where it was, and the keys belong to the focused area.
 */
const focusIsOnList = (target: HTMLElement | null): boolean =>
    target === null || target === document.body || target.closest('[data-focus-area="sidebar"]') !== null;

interface UseThreadListKeyboardProps {
    handleArrowDown: () => void;
    handleArrowUp: () => void;
    handleEnter: () => void;
    handleKeyboardEscape: () => void;
    /** Opens the keyboard-selected thread's options menu (the context-menu key). False when nothing opened, so the key stays with the browser. */
    handleOpenSelectedMenu: () => boolean;
    /** Opens the rename dialog for the keyboard-selected thread (F2). */
    handleRenameSelected: () => void;
    handleSelectAll: () => void;
    isKeyboardNavigating: boolean;
    isSelectionMode: boolean;
    navigate: (options: { from: string; params?: { threadId: string }; search?: any; to: string }) => void;
    onExitSelectionMode: () => void;
    selectedThreadIndex: number;
    setShowKeyboardHelp: (value: boolean | ((previous: boolean) => boolean)) => void;
}

/**
 * Extracted keyboard shortcut handler for the thread list.
 * Manages all keyboard shortcuts (navigation, actions, selection).
 */
const useThreadListKeyboard = ({
    handleArrowDown,
    handleArrowUp,
    handleEnter,
    handleKeyboardEscape,
    handleOpenSelectedMenu,
    handleRenameSelected,
    handleSelectAll,
    isKeyboardNavigating,
    isSelectionMode,
    navigate,
    onExitSelectionMode,
    setShowKeyboardHelp,
}: UseThreadListKeyboardProps) => {
    const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
        // Don't handle shortcuts if user is typing in an input
        // Check if user is composing text (IME) or if event is already handled
        if (event.isComposing || event.defaultPrevented) {
            return;
        }

        const target = event.target as HTMLElement | null;
        const activeElement = document.activeElement as HTMLElement | null;

        // Helper to check if an element is an input - be very thorough
        const isInputElement = (element: HTMLElement | null): boolean => {
            if (!element) {
                return false;
            }

            // Ensure it's actually an HTMLElement before calling methods
            if (!(element instanceof HTMLElement)) {
                return false;
            }

            // Check direct instance
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
                return true;
            }

            // Check contentEditable
            if (element.isContentEditable === true) {
                return true;
            }

            // Check tag name (case-insensitive)
            const tagName = element.tagName?.toUpperCase();

            if (tagName === "INPUT" || tagName === "TEXTAREA") {
                return true;
            }

            // Check closest input/textarea/contenteditable
            if (element.closest?.("input, textarea, [contenteditable], [data-composer-input]")) {
                return true;
            }

            // Check for data-composer-input attribute
            if (element.hasAttribute?.("data-composer-input")) {
                return true;
            }

            return false;
        };

        // Check both target and activeElement to catch all input scenarios
        // This is critical - we must never interfere with typing
        if (isInputElement(target) || isInputElement(activeElement)) {
            return;
        }

        // A key pressed in an open dialog or menu (Save, Cancel, a menu item) belongs to that control, not to the selected row.
        if (target !== null && target.closest('[role="dialog"]:not([data-mobile="true"]), [role="menu"]') !== null) {
            return;
        }

        const isCtrlOrCommand = event.ctrlKey || event.metaKey;

        switch (event.key) {
            case "?": {
                if (!isCtrlOrCommand) {
                    event.preventDefault();
                    setShowKeyboardHelp((previous) => !previous);
                }

                break;
            }

            case "a":
            case "A": {
                if (isCtrlOrCommand && isSelectionMode) {
                    event.preventDefault();
                    handleSelectAll();
                }

                break;
            }
            case "ArrowDown": {
                if (!isCtrlOrCommand) {
                    event.preventDefault();
                    handleArrowDown();
                }

                break;
            }

            case "ArrowUp": {
                if (!isCtrlOrCommand) {
                    event.preventDefault();
                    handleArrowUp();
                }

                break;
            }
            case "ContextMenu": {
                // Taken only when a menu opens: otherwise the browser's own menu shows, as it does for a right-click on that row.
                if (isKeyboardNavigating && !isSelectionMode && focusIsOnList(target) && handleOpenSelectedMenu()) {
                    event.preventDefault();
                    suppressNextContextMenu(target);
                }

                break;
            }
            case "Enter": {
                if (isKeyboardNavigating) {
                    event.preventDefault();
                    handleEnter();
                }

                break;
            }
            case "Escape": {
                if (isSelectionMode) {
                    event.preventDefault();
                    onExitSelectionMode();
                } else {
                    if (isKeyboardNavigating) {
                        event.preventDefault();
                    }

                    handleKeyboardEscape();
                    setShowKeyboardHelp(false);
                }

                break;
            }
            case "F2": {
                if (isKeyboardNavigating && !isSelectionMode && focusIsOnList(target)) {
                    event.preventDefault();
                    handleRenameSelected();
                }

                break;
            }

            case "n":
            case "N": {
                if (isCtrlOrCommand) {
                    event.preventDefault();
                    // Navigate to new thread
                    navigate({ from: "/chat/$threadId", search: {}, to: "/chat" });
                }

                break;
            }

            default: {
                break;
            }
        }
    });

    // Add keyboard event listeners
    useEffect(() => {
        document.addEventListener("keydown", handleKeyDown);

        return () => {
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, []);
};

export default useThreadListKeyboard;
