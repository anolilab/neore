/**
 * The send-key setting through the REAL composer editor: with `modEnter` on, Enter inserts a line and Ctrl/Cmd+Enter
 * sends exactly once. The keymap is wired in the editor, so a unit test of `resolveEnterAction` alone cannot show that
 * the key reaches the send callback.
 */
import { act, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import type { ComposerTiptapEditorRef } from "./composer-tiptap-editor";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: null };
        },
    };
});

vi.mock("@/features/chat/core/hooks/use-favorite-models", () => {
    return {
        default: () => {
            return { favoriteModelIds: [] };
        },
    };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => [] };
});

vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatMessages: () => {
            return { messages: [] };
        },
    };
});

vi.mock("./slash-command-popup", () => {
    return { default: () => null };
});

vi.mock("./file-mention-popup", () => {
    return { default: () => null };
});

vi.mock("./use-mention-prefetch", () => {
    return { default: () => false };
});

vi.mock("./variable-autocomplete-popup", () => {
    return { default: () => null };
});

const { ComposerTiptapEditor } = await import("./composer-tiptap-editor");

/** A key as the keyboard sends it: to whatever has the focus, which must still be the editor. */
const press = (element: HTMLElement, init: KeyboardEventInit) => {
    /* eslint-disable testing-library/no-node-access -- the focused element is what is under test: a key goes where focus is */
    expect(document.activeElement).toBe(element);
    act(() => {
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    });
    /* eslint-enable testing-library/no-node-access */
};

describe("ComposerTiptapEditor send key", () => {
    beforeAll(() => {
        // ProseMirror scrolls the selection into view on every edit; jsdom has no layout for ranges.
        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = () => new DOMRect();
    });

    afterEach(() => {
        useUIStateStore.getState().setUserPreferences({ sendBehavior: "enter" });
    });

    it("modEnter: Enter inserts a line and Ctrl+Enter sends once", async () => {
        useUIStateStore.getState().setUserPreferences({ sendBehavior: "modEnter" });
        const ref = createRef<ComposerTiptapEditorRef>();
        const onSubmit = vi.fn();
        const view = render(<ComposerTiptapEditor onChange={() => undefined} onSubmit={onSubmit} ref={ref} value="" />);

        await waitFor(() => {
            expect(ref.current?.getEditor()).toBeTruthy();
        });

        const editor = ref.current!.getEditor()!;
        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the editor has no role to query by
        const element = view.container.querySelector(".ProseMirror") as HTMLElement;

        act(() => {
            editor.commands.focus();
            element.focus();
            editor.commands.insertContent("first line");
        });

        press(element, { key: "Enter" });

        expect(onSubmit).not.toHaveBeenCalled();
        expect(editor.getText()).toContain("first line\n");

        act(() => {
            editor.commands.insertContent("second line");
        });

        press(element, { ctrlKey: true, key: "Enter" });

        expect(onSubmit).toHaveBeenCalledOnce();
    });

    it("enter: Enter still sends, so the default is unchanged", async () => {
        const ref = createRef<ComposerTiptapEditorRef>();
        const onSubmit = vi.fn();
        const view = render(<ComposerTiptapEditor onChange={() => undefined} onSubmit={onSubmit} ref={ref} value="" />);

        await waitFor(() => {
            expect(ref.current?.getEditor()).toBeTruthy();
        });

        const editor = ref.current!.getEditor()!;
        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the editor has no role to query by
        const element = view.container.querySelector(".ProseMirror") as HTMLElement;

        act(() => {
            editor.commands.focus();
            element.focus();
            editor.commands.insertContent("hello");
        });

        press(element, { key: "Enter" });

        expect(onSubmit).toHaveBeenCalledOnce();
    });
});
