import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KeyboardShortcutsManager, useKeyboardShortcuts } from "./keyboard-shortcuts-manager";

// Mock the UI state hook that provides keyboard shortcuts
const mockKeyboardShortcuts = {
    audioRecord: "ctrl+shift+r",
    commandPalette: "ctrl+k",
    escape: "escape",
    firstItem: "home",
    focusSearch: "ctrl+f",
    help: "ctrl+/",
    lastItem: "end",
    newChat: "ctrl+n",
    newTemporaryChat: "ctrl+shift+n",
    nextItem: "arrowdown",
    prevItem: "arrowup",
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

    it("leaves a bare-key copy binding to the field it is typed into", () => {
        const onShortcut = vi.fn();

        render(
            <KeyboardShortcutsManager onShortcut={onShortcut} shortcuts={{ copyLastCodeBlock: "x" }}>
                <textarea aria-label="composer" />
            </KeyboardShortcutsManager>,
        );

        const notPrevented = fireEvent.keyDown(screen.getByLabelText("composer"), { code: "KeyX", key: "x" });

        expect(onShortcut).not.toHaveBeenCalled();
        expect(notPrevented).toBe(true);
    });

    it("still runs a modifier chord copy binding from the composer", () => {
        const onShortcut = vi.fn();

        render(
            <KeyboardShortcutsManager onShortcut={onShortcut} shortcuts={{ copyLastCodeBlock: "ctrl+shift+x" }}>
                <textarea aria-label="composer" />
            </KeyboardShortcutsManager>,
        );

        const notPrevented = fireEvent.keyDown(screen.getByLabelText("composer"), { code: "KeyX", ctrlKey: true, key: "X", shiftKey: true });

        expect(onShortcut).toHaveBeenCalledWith("copyLastCodeBlock", expect.anything());
        expect(notPrevented).toBe(false);
    });

    it("opens the model picker from the composer on a modifier chord", () => {
        const onShortcut = vi.fn();

        render(
            <KeyboardShortcutsManager onShortcut={onShortcut} shortcuts={{ openModelPicker: "ctrl+shift+m" }}>
                <textarea aria-label="composer" />
            </KeyboardShortcutsManager>,
        );

        const notPrevented = fireEvent.keyDown(screen.getByLabelText("composer"), { code: "KeyM", ctrlKey: true, key: "M", shiftKey: true });

        expect(onShortcut).toHaveBeenCalledWith("openModelPicker", expect.anything());
        expect(notPrevented).toBe(false);
    });

    it("leaves a bare-key model picker binding to the field it is typed into", () => {
        const onShortcut = vi.fn();

        render(
            <KeyboardShortcutsManager onShortcut={onShortcut} shortcuts={{ openModelPicker: "m" }}>
                <textarea aria-label="composer" />
            </KeyboardShortcutsManager>,
        );

        fireEvent.keyDown(screen.getByLabelText("composer"), { code: "KeyM", key: "m" });

        expect(onShortcut).not.toHaveBeenCalled();
    });

    it("steps the composer effort from the editor on a bound modifier chord", () => {
        const onShortcut = vi.fn();

        render(
            <KeyboardShortcutsManager onShortcut={onShortcut} shortcuts={{ decreaseEffort: "alt+arrowdown", increaseEffort: "alt+arrowup" }}>
                <textarea aria-label="composer" />
            </KeyboardShortcutsManager>,
        );

        const composer = screen.getByLabelText("composer");
        const upNotPrevented = fireEvent.keyDown(composer, { altKey: true, code: "ArrowUp", key: "ArrowUp" });
        const downNotPrevented = fireEvent.keyDown(composer, { altKey: true, code: "ArrowDown", key: "ArrowDown" });

        expect(onShortcut).toHaveBeenCalledWith("increaseEffort", expect.anything());
        expect(onShortcut).toHaveBeenCalledWith("decreaseEffort", expect.anything());
        expect(upNotPrevented).toBe(false);
        expect(downNotPrevented).toBe(false);
    });

    it("runs only the decrease command when both effort commands hold the same chord", () => {
        const onShortcut = vi.fn();

        render(
            <KeyboardShortcutsManager onShortcut={onShortcut} shortcuts={{ decreaseEffort: "alt+arrowdown", increaseEffort: "alt+arrowdown" }}>
                <textarea aria-label="composer" />
            </KeyboardShortcutsManager>,
        );

        fireEvent.keyDown(screen.getByLabelText("composer"), { altKey: true, code: "ArrowDown", key: "ArrowDown" });

        expect(onShortcut).toHaveBeenCalledTimes(1);
        expect(onShortcut).toHaveBeenCalledWith("decreaseEffort", expect.anything());
    });

    it("leaves a chord another command already has to that command", () => {
        const onShortcut = vi.fn();

        render(
            <KeyboardShortcutsManager onShortcut={onShortcut} shortcuts={{ increaseEffort: "alt+n", newChat: "alt+n" }}>
                <button aria-label="page" type="button" />
            </KeyboardShortcutsManager>,
        );

        fireEvent.keyDown(screen.getByLabelText("page"), { altKey: true, code: "KeyN", key: "n" });

        expect(onShortcut).toHaveBeenCalledTimes(1);
        expect(onShortcut).toHaveBeenCalledWith("newChat", expect.anything());
    });

    it("leaves the arrow chords to the editor while the effort commands are unbound", () => {
        const onShortcut = vi.fn();

        render(
            <KeyboardShortcutsManager onShortcut={onShortcut}>
                <textarea aria-label="composer" />
            </KeyboardShortcutsManager>,
        );

        const composer = screen.getByLabelText("composer");

        fireEvent.keyDown(composer, { altKey: true, code: "ArrowUp", key: "ArrowUp" });
        fireEvent.keyDown(composer, { altKey: true, code: "ArrowDown", key: "ArrowDown" });

        expect(onShortcut).not.toHaveBeenCalledWith("increaseEffort", expect.anything());
        expect(onShortcut).not.toHaveBeenCalledWith("decreaseEffort", expect.anything());
    });

    describe("a recorded Control chord for the effort commands", () => {
        const pressChord = (modifier: "ctrlKey" | "metaKey") => {
            const onShortcut = vi.fn();

            const { unmount } = render(
                <KeyboardShortcutsManager onShortcut={onShortcut} shortcuts={{ increaseEffort: "ctrl+arrowup" }}>
                    <textarea aria-label="composer" />
                </KeyboardShortcutsManager>,
            );

            fireEvent.keyDown(screen.getByLabelText("composer"), { code: "ArrowUp", key: "ArrowUp", [modifier]: true });
            unmount();

            return onShortcut;
        };

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("fires on Command and on Control on a Mac", () => {
            vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");

            expect(pressChord("metaKey")).toHaveBeenCalledWith("increaseEffort", expect.anything());
            expect(pressChord("ctrlKey")).toHaveBeenCalledWith("increaseEffort", expect.anything());
        });

        it("does not run both commands when a Control chord and its Command twin are bound on a Mac", () => {
            vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");

            const onShortcut = vi.fn();

            render(
                <KeyboardShortcutsManager onShortcut={onShortcut} shortcuts={{ decreaseEffort: "ctrl+arrowdown", increaseEffort: "cmd+arrowdown" }}>
                    <textarea aria-label="composer" />
                </KeyboardShortcutsManager>,
            );

            fireEvent.keyDown(screen.getByLabelText("composer"), { code: "ArrowDown", key: "ArrowDown", metaKey: true });

            expect(onShortcut).toHaveBeenCalledTimes(1);
            expect(onShortcut).toHaveBeenCalledWith("decreaseEffort", expect.anything());
        });

        it("fires on Control, not on Command, elsewhere", () => {
            vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
            vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0)");

            expect(pressChord("ctrlKey")).toHaveBeenCalledWith("increaseEffort", expect.anything());
            expect(pressChord("metaKey")).not.toHaveBeenCalled();
        });
    });
});
