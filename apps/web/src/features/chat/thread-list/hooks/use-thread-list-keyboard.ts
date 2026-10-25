import { useEffect, useEffectEvent } from "react";

interface UseThreadListKeyboardProps {
    handleArrowDown: () => void;
    handleArrowUp: () => void;
    handleEnter: () => void;
    handleKeyboardEscape: () => void;
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
