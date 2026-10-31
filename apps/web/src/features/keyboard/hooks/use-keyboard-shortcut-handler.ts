import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useThreadListUIStore } from "@/features/chat/thread-list/stores/thread-list-ui-store";
import type { KeyboardShortcuts } from "@/features/layout/stores/ui-state-store";

import { FIND_IN_THREAD_EVENT, hasFindInThreadTarget } from "../lib/find-in-thread-target";
import { focusThreadSearch } from "../lib/thread-search-target";

// No-op handler for SSR - keyboard shortcuts only work on client
const noopHandler = (_action: keyof KeyboardShortcuts, _event: KeyboardEvent): void => {};

const focusableItems = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>('[tabindex="0"], button, input, textarea, select, a')].filter(
        (element) => !element.matches(":disabled") && !element.closest('[aria-hidden="true"], [hidden]') && element.getClientRects().length > 0,
    );

const useKeyboardShortcutHandler = (): ((action: keyof KeyboardShortcuts, event: KeyboardEvent) => void) => {
    const navigate = useNavigate({ from: "/chat/$threadId" as "/chat/$threadId" | "/dashboard" });

    const handleShortcut = useCallback(
        (action: keyof KeyboardShortcuts, event: KeyboardEvent) => {
            // Skip function properties from the keyboard shortcuts object
            if (typeof action !== "string") {
                return;
            }

            switch (action) {
                case "audioRecord": {
                    // Dispatch custom event for audio recording
                    // The audio recording hook listens for this event
                    globalThis.dispatchEvent(new CustomEvent("audioRecordToggle"));

                    break;
                }
                // commandPalette is handled by the GlobalCommandPalette component itself using rooks useKey
                case "commandPalette": {
                    // Handled by GlobalCommandPalette component, no action needed here
                    break;
                }
                case "copyLastCodeBlock": {
                    // The thread's listener owns the messages and the clipboard (`copy-last-code-block.tsx`).
                    globalThis.dispatchEvent(new CustomEvent("copyLastCodeBlock"));
                    break;
                }
                case "decreaseEffort": {
                    // The composer's effort listener owns the value (`composer-effort-shortcuts.tsx`).
                    globalThis.dispatchEvent(new CustomEvent("composer.decreaseEffort"));
                    break;
                }
                case "escape": {
                    // Close modals, blur inputs, etc.
                    const activeElement = document.activeElement as HTMLElement;

                    if (activeElement && (activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA")) {
                        activeElement.blur();
                    } else {
                        // Dispatch escape event to close any open dialogs
                        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
                    }

                    break;
                }
                case "findInThread": {
                    if (hasFindInThreadTarget()) {
                        // The open thread's find bar owns the query and the highlights (`thread-find-bar.tsx`).
                        globalThis.dispatchEvent(new CustomEvent(FIND_IN_THREAD_EVENT));
                    } else {
                        // Not on a thread: the chord's older meaning.
                        focusThreadSearch();
                    }

                    break;
                }
                case "firstItem": {
                    // Navigate to first item
                    const items = focusableItems();

                    items[0]?.focus();
                    break;
                }
                case "focusSearch": {
                    // Opens the thread list's search bar when it is closed, then focuses its input.
                    focusThreadSearch();

                    break;
                }
                case "help": {
                    // The shortcuts sheet (`keyboard-shortcuts-sheet.tsx`) shares its open state with the thread list.
                    useThreadListUIStore.getState().toggleShowKeyboardHelp();

                    break;
                }
                case "increaseEffort": {
                    globalThis.dispatchEvent(new CustomEvent("composer.increaseEffort"));
                    break;
                }
                case "lastItem": {
                    // Navigate to last item
                    const items = focusableItems();

                    items.at(-1)?.focus();
                    break;
                }
                case "newChat": {
                    navigate({ from: "/chat/$threadId" as "/chat/$threadId" | "/dashboard", search: {}, to: "/chat" });
                    break;
                }
                case "newTemporaryChat": {
                    // Dispatch custom event for temporary chat creation
                    // The TemporaryChatDropdown component listens for this event
                    globalThis.dispatchEvent(new CustomEvent("newTemporaryChat"));
                    break;
                }
                // Navigation shortcuts
                case "nextItem": {
                    // Navigate to next item (implementation depends on current context)
                    const focusedElement = document.activeElement;
                    const items = focusableItems();
                    const currentIndex = items.indexOf(focusedElement as HTMLElement);
                    const nextIndex = (currentIndex + 1) % items.length;

                    items[nextIndex]?.focus();
                    break;
                }

                case "openModelPicker": {
                    // The composer's model picker listens (`model-picker-button.tsx`) and owns the model change.
                    globalThis.dispatchEvent(new CustomEvent("openModelPicker"));
                    break;
                }
                case "prevItem": {
                    // Navigate to previous item
                    const focusedElement = document.activeElement;
                    const items = focusableItems();
                    const currentIndex = items.indexOf(focusedElement as HTMLElement);
                    const previousIndex = (currentIndex <= 0 ? items.length : currentIndex) - 1;

                    items[previousIndex]?.focus();
                    break;
                }
                // sidebarLeft and sidebarRight are handled by TanStackSidebarProvider
                case "sidebarLeft":
                case "sidebarRight": {
                    // These are handled by the TanStack sidebar provider, no action needed here
                    break;
                }
                default: {
                    console.warn("Unhandled keyboard shortcut:", action, event);
                }
            }
        },
        [navigate],
    );

    // During SSR, hand back a no-op since keyboard shortcuts don't apply.
    // Decided after the hooks run so the hook order never changes.
    return globalThis.window === undefined ? noopHandler : handleShortcut;
};

export default useKeyboardShortcutHandler;
