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
        handlerThreadId: undefined as string | undefined,
        optimistic: new Map<string, string>(),
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
        useOptimisticStatuses: () => state.optimistic,
    };
});

vi.mock("@/features/chat/core/hooks/use-current-model", () => {
    return { default: () => "model-x" };
});

vi.mock("@/features/chat/thread-list/hooks/use-thread-handlers", () => {
    return {
        default: (_setLoadingStates: unknown, threadId?: string) => {
            state.handlerThreadId = threadId;

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

const listener = (props: { model?: string; status?: string } = {}) => (
    <Shortcuts>
        <ThreadShortcutsListener {...props} />
    </Shortcuts>
);

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
        state.optimistic = new Map();
        state.threadId = "t1";
        state.handlerThreadId = undefined;
    });

    it("the archive shortcut archives the open thread on the global model when the thread has none", () => {
        render(listener({ status: "active" }));

        pressArchive();

        expect(state.updateThread).toHaveBeenCalledWith("t1", "model-x", "archived");
    });

    it("the archive shortcut archives through the open thread's own model, not the globally selected one", () => {
        render(listener({ model: "thread-model", status: "active" }));

        pressArchive();

        expect(state.updateThread).toHaveBeenCalledWith("t1", "thread-model", "archived");
    });

    it("the archive shortcut restores the open thread when its stored status is archived", () => {
        render(listener({ model: "thread-model", status: "archived" }));

        pressArchive();

        expect(state.updateThread).toHaveBeenCalledWith("t1", "thread-model", "active");
    });

    it("a second archive press while the first is pending restores, reading the pending status", () => {
        state.optimistic.set("t1", "archived");
        render(listener({ model: "thread-model", status: "active" }));

        pressArchive();

        expect(state.updateThread).toHaveBeenCalledWith("t1", "thread-model", "active");
    });

    it("the delete shortcut asks first and deletes only after the owner confirms", () => {
        render(listener());

        pressDelete();

        expect(state.handleDeleteThread).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

        expect(state.handleDeleteThread).toHaveBeenCalledWith("t1");
    });

    it("deletes the thread the dialog was opened for, even if the route moved to another thread meanwhile", () => {
        const view = render(listener());

        pressDelete();
        state.threadId = "t2";
        view.rerender(listener());
        fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

        expect(state.handleDeleteThread).toHaveBeenCalledWith("t1");
    });

    it("hands the open thread to the thread handlers, so deleting it leaves its route", () => {
        render(listener());

        expect(state.handlerThreadId).toBe("t1");
    });

    it("does nothing when no thread is open", () => {
        state.threadId = undefined;

        render(listener());

        pressArchive();
        pressDelete();

        expect(state.updateThread).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Confirm delete" })).toBeNull();
    });
});
