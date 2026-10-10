import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import type { KeyboardShortcuts } from "@/features/layout/stores/ui-state-store";

// No-op handler for SSR - keyboard shortcuts only work on client
const noopHandler = (_action: keyof KeyboardShortcuts, _event: KeyboardEvent): void => {};

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
                case "firstItem": {
                    // Navigate to first item
                    const items = [...document.querySelectorAll('[tabindex="0"], button, input, a')];

                    (items[0] as HTMLElement)?.focus();
                    break;
                }
                case "focusSearch":
                case "search": {
                    // Trigger search modal or focus search input
                    const searchInput =
                        document.querySelector<HTMLInputElement>("[data-search-input]") ||
                        document.querySelector<HTMLInputElement>('[data-testid="search-input"]');

                    if (searchInput) {
                        searchInput.focus();
                    }

                    break;
                }
                case "help": {
                    // Open help modal or navigate to help page
                    const helpButton = document.querySelector<HTMLButtonElement>('[data-testid="help-button"]');

                    if (helpButton) {
                        helpButton.click();
                    } else {
                        // Fallback to help page if no help button found
                        navigate({ from: "/chat/$threadId" as "/chat/$threadId" | "/dashboard", to: "/help" });
                    }

                    break;
                }
                case "lastItem": {
                    // Navigate to last item
                    const items = [...document.querySelectorAll('[tabindex="0"], button, input, a')];

                    (items.at(-1) as HTMLElement)?.focus();
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
                    const items = [...document.querySelectorAll('[tabindex="0"], button, input, a')];
                    const currentIndex = items.indexOf(focusedElement as Element);
                    const nextIndex = (currentIndex + 1) % items.length;

                    (items[nextIndex] as HTMLElement)?.focus();
                    break;
                }

                case "prevItem": {
                    // Navigate to previous item
                    const focusedElement = document.activeElement;
                    const items = [...document.querySelectorAll('[tabindex="0"], button, input, a')];
                    const currentIndex = items.indexOf(focusedElement as Element);
                    const previousIndex = (currentIndex <= 0 ? items.length : currentIndex) - 1;

                    (items[previousIndex] as HTMLElement)?.focus();
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
