/**
 * The archive and delete shortcuts, driven by a real keydown through the keyboard manager, into the listener that
 * owns the open thread. A selector or event name that matches nothing fails here.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KeyboardShortcutsManager } from "@/features/keyboard/components/keyboard-shortcuts-manager";
import useKeyboardShortcutHandler from "@/features/keyboard/hooks/use-keyboard-shortcut-handler";

import ThreadShortcutsListener from "./thread-shortcuts-listener";

const state = vi.hoisted(() => {
    return {
        handleDeleteThread: vi.fn(),
        metadata: new Map<string, { status: string }>(),
        threadId: "t1" as string | undefined,
        updateThread: vi.fn(),
    };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: ReactNode }) => children,
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        useNavigate: () => vi.fn(),
    };
});

// The sheet uses the lingui macro, which these tests do not compile; it has its own coverage.
vi.mock("@/features/keyboard/components/keyboard-shortcuts-sheet", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/core/stores/thread-store-hooks", () => {
    return {
        useCurrentThreadId: () => state.threadId,
        useThreadMetadata: () => state.metadata,
    };
});

vi.mock("@/features/chat/core/hooks/use-current-model", () => {
    return { default: () => "model-x" };
});

vi.mock("@/features/chat/thread-list/hooks/use-thread-handlers", () => {
    return {
        default: () => {
            return { handleDeleteThread: state.handleDeleteThread, updateThread: state.updateThread };
        },
    };
});

// The real dialog is a portal over the app; the stand-in shows its confirm button only while open.
vi.mock("@/components/delete-confirmation-dialog", () => {
    return {
        default: ({ onConfirm, open }: { onConfirm: () => void; open: boolean }) =>
            open ? (
                <button onClick={onConfirm} type="button">
                    Confirm delete
                </button>
            ) : null,
    };
});

const Shortcuts = ({ children }: { children?: ReactNode }) => {
    const onShortcut = useKeyboardShortcutHandler();

    return (
        <KeyboardShortcutsManager onShortcut={onShortcut} shortcuts={{ archiveThread: "ctrl+shift+a", deleteThread: "ctrl+shift+backspace" }}>
            {children}
        </KeyboardShortcutsManager>
    );
};

const pressArchive = (): void => {
    fireEvent.keyDown(document.body, { code: "KeyA", ctrlKey: true, key: "A", shiftKey: true });
};

const pressDelete = (): void => {
    fireEvent.keyDown(document.body, { code: "Backspace", ctrlKey: true, key: "Backspace", shiftKey: true });
};

describe("thread shortcuts", () => {
    beforeEach(() => {
        state.handleDeleteThread.mockReset();
        state.updateThread.mockReset();
        state.metadata = new Map();
        state.threadId = "t1";
    });

    it("the archive shortcut archives the open thread", () => {
        render(
            <Shortcuts>
                <ThreadShortcutsListener />
            </Shortcuts>,
        );

        pressArchive();

        expect(state.updateThread).toHaveBeenCalledWith("t1", "model-x", "archived");
    });

    it("the archive shortcut restores the open thread when it is already archived", () => {
        state.metadata = new Map([["t1", { status: "archived" }]]);

        render(
            <Shortcuts>
                <ThreadShortcutsListener />
            </Shortcuts>,
        );

        pressArchive();

        expect(state.updateThread).toHaveBeenCalledWith("t1", "model-x", "active");
    });

    it("the delete shortcut asks first and deletes only after the owner confirms", () => {
        render(
            <Shortcuts>
                <ThreadShortcutsListener />
            </Shortcuts>,
        );

        pressDelete();

        expect(state.handleDeleteThread).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

        expect(state.handleDeleteThread).toHaveBeenCalledWith("t1");
    });

    it("does nothing when no thread is open", () => {
        state.threadId = undefined;

        render(
            <Shortcuts>
                <ThreadShortcutsListener />
            </Shortcuts>,
        );

        pressArchive();
        pressDelete();

        expect(state.updateThread).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Confirm delete" })).toBeNull();
    });
});
