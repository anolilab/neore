import { useEffect } from "react";

import type { BranchNode } from "../types";

interface UseThreadListKeyboardProps {
    currentThreadId: string | undefined;
    flattenedThreads: BranchNode[];
    handleArrowDown: () => void;
    handleArrowUp: () => void;
    handleCreateBranch: (threadId: string) => void;
    handleDeleteThread: (threadId: string) => void;
    handleEnter: () => void;
    handleKeyboardEscape: () => void;
    handlePinThread: (threadId: string) => void;
    handleSelectAll: () => void;
    handleUnpinThread: (threadId: string) => void;
    isKeyboardNavigating: boolean;
    isSelectionMode: boolean;
    navigate: (options: { from: string; params?: { threadId: string }; search?: any; to: string }) => void;
    onExitSelectionMode: () => void;
    selectedThreadIndex: number;
    setShowKeyboardHelp: (value: boolean | ((previous: boolean) => boolean)) => void;
    setShowSearch: (value: boolean | ((previous: boolean) => boolean)) => void;
    updateThread: (threadId: string, model: string, status: "archived" | "active") => void;
}

/**
 * Extracted keyboard shortcut handler for the thread list.
 * Manages all keyboard shortcuts (navigation, actions, selection).
 */
const useThreadListKeyboard = ({
    currentThreadId,
    flattenedThreads,
    handleArrowDown,
    handleArrowUp,
    handleCreateBranch,
    handleDeleteThread,
    handleEnter,
    handleKeyboardEscape,
    handlePinThread,
    handleSelectAll,
    handleUnpinThread,
    isKeyboardNavigating,
    isSelectionMode,
    navigate,
    onExitSelectionMode,
    setShowKeyboardHelp,
    setShowSearch,
    updateThread,
}: UseThreadListKeyboardProps) => {
    const handleKeyDown = (event: KeyboardEvent) => {
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
                    break;
                }

                // Fall through to existing archive logic if not in selection mode
                if (isCtrlOrCommand && currentThreadId) {
                    event.preventDefault();
                    const currentThread = flattenedThreads.find((t) => t.threadId === currentThreadId);

                    if (currentThread) {
                        const model = currentThread.model || "gemini-1.5-flash"; // Default model

                        if (currentThread.status === "archived") {
                            updateThread(currentThreadId, model, "active");
                        } else {
                            updateThread(currentThreadId, model, "archived");
                        }
                    }
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
            case "b":
            case "B": {
                // Input check already handled at the top of the function
                // This ensures ALL single-letter shortcuts (a, b, d, f, n, p, etc.) are protected
                if (isCtrlOrCommand && currentThreadId) {
                    event.preventDefault();
                    handleCreateBranch(currentThreadId);
                }

                break;
            }
            case "d":
            case "D": {
                if (isCtrlOrCommand && currentThreadId) {
                    event.preventDefault();
                    handleDeleteThread(currentThreadId);
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
                event.preventDefault();

                if (isSelectionMode) {
                    onExitSelectionMode();
                } else {
                    handleKeyboardEscape();
                    setShowKeyboardHelp(false);
                }

                break;
            }

            case "f":
            case "F": {
                if (isCtrlOrCommand) {
                    event.preventDefault();
                    setShowSearch((previous) => !previous);
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

            case "p":
            case "P": {
                if (isCtrlOrCommand && currentThreadId) {
                    event.preventDefault();
                    const currentThread = flattenedThreads.find((t) => t.threadId === currentThreadId);

                    if (currentThread) {
                        if (currentThread.isPinned) {
                            handleUnpinThread(currentThreadId);
                        } else {
                            handlePinThread(currentThreadId);
                        }
                    }
                }

                break;
            }

            default: {
                break;
            }
        }
    };

    // Add keyboard event listeners
    useEffect(() => {
        document.addEventListener("keydown", handleKeyDown);

        return () => {
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [handleKeyDown]);
};

export default useThreadListKeyboard;
