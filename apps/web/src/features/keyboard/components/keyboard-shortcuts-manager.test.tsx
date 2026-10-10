import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { KeyboardShortcutsManager, useKeyboardShortcuts } from "./keyboard-shortcuts-manager";

// Mock the UI state hook that provides keyboard shortcuts
const mockKeyboardShortcuts = {
    archiveThread: "ctrl+a",
    audioRecord: "ctrl+shift+r",
    commandPalette: "ctrl+k",
    createBranch: "ctrl+shift+c",
    deleteThread: "ctrl+d",
    escape: "escape",
    firstItem: "home",
    focusSearch: "ctrl+f",
    help: "ctrl+/",
    lastItem: "end",
    newChat: "ctrl+n",
    newTemporaryChat: "ctrl+shift+n",
    nextItem: "arrowdown",
    pinThread: "ctrl+p",
    prevItem: "arrowup",
    search: "ctrl+k",
    sidebarLeft: "ctrl+b",
    sidebarRight: "ctrl+shift+b",
};

vi.mock("@/features/layout/hooks/use-ui-state", () => {
    return {
        useKeyboardShortcuts: () => {
            return {
                keyboardShortcuts: mockKeyboardShortcuts,
                resetKeyboardShortcuts: vi.fn(),
                setKeyboardShortcuts: vi.fn(),
            };
        },
    };
});

// Test component to access context
const TestComponent = () => {
    const { shortcuts } = useKeyboardShortcuts();

    return (
        <div>
            <div data-testid="sidebar-left">{shortcuts.sidebarLeft}</div>
            <div data-testid="sidebar-right">{shortcuts.sidebarRight}</div>
            <div data-testid="new-chat">{shortcuts.newChat}</div>
        </div>
    );
};

describe("KeyboardShortcutsManager", () => {
    it("should provide shortcuts via context", () => {
        render(
            <KeyboardShortcutsManager>
                <TestComponent />
            </KeyboardShortcutsManager>,
        );

        expect(screen.getByTestId("sidebar-left").textContent).toBe("ctrl+b");
        expect(screen.getByTestId("sidebar-right").textContent).toBe("ctrl+shift+b");
        expect(screen.getByTestId("new-chat").textContent).toBe("ctrl+n");
    });

    it("should merge prop overrides with store shortcuts", () => {
        render(
            <KeyboardShortcutsManager shortcuts={{ newChat: "alt+n" }}>
                <TestComponent />
            </KeyboardShortcutsManager>,
        );

        // newChat should be overridden by the prop
        expect(screen.getByTestId("new-chat").textContent).toBe("alt+n");
        // sidebarLeft should still come from the store
        expect(screen.getByTestId("sidebar-left").textContent).toBe("ctrl+b");
    });

    it("should throw error when hook is used outside provider", () => {
        const TestComponentWithError = () => {
            useKeyboardShortcuts();

            return <div>Should not render</div>;
        };

        // React re-reports the render error through console.error before rethrowing it.
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            expect(() => render(<TestComponentWithError />)).toThrow("useKeyboardShortcuts must be used within KeyboardShortcutsManager");
        } finally {
            consoleError.mockRestore();
        }
    });

    it("should render children", () => {
        render(
            <KeyboardShortcutsManager>
                <div data-testid="child">Hello</div>
            </KeyboardShortcutsManager>,
        );

        expect(screen.getByTestId("child").textContent).toBe("Hello");
    });
});
