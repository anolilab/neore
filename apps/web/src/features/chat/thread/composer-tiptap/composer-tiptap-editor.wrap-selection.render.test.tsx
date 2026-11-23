/**
 * A marker typed over a selection in the REAL composer editor wraps the selection. The keystroke goes through the keyboard
 * events ProseMirror handles, so this covers the editor's own `handleTextInput` wiring, not only the wrap logic.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TextSelection } from "@tiptap/pm/state";
import { createRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

const requestCompletion = async () => null;

describe("ComposerTiptapEditor wraps a selection when a marker is typed", () => {
    // ProseMirror scrolls the selection into view on every edit; jsdom has no layout for ranges.
    beforeAll(() => {
        const emptyRect = () => new DOMRect();

        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = emptyRect;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("wraps the selected word in bold when an asterisk is typed over it", async () => {
        const ref = createRef<ComposerTiptapEditorRef>();
        const onChange = vi.fn();

        render(<ComposerTiptapEditor onChange={onChange} onSubmit={() => {}} ref={ref} requestCompletion={requestCompletion} value="hello world" />);
        await waitFor(() => {
            expect(ref.current?.getEditor()).toBeTruthy();
        });

        const editor = ref.current?.getEditor();

        if (!editor) {
            throw new Error("the composer editor did not mount");
        }

        // Focused directly: a click asks for layout (`elementFromPoint`) that jsdom does not have.
        act(() => {
            screen.getByRole("textbox").focus();
            editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7, 12)));
        });

        await userEvent.setup().keyboard("*");

        expect(onChange).toHaveBeenLastCalledWith("hello **world**");
    });

    it("replaces the selection as before when a letter is typed over it", async () => {
        const ref = createRef<ComposerTiptapEditorRef>();
        const onChange = vi.fn();

        render(<ComposerTiptapEditor onChange={onChange} onSubmit={() => {}} ref={ref} requestCompletion={requestCompletion} value="hello world" />);
        await waitFor(() => {
            expect(ref.current?.getEditor()).toBeTruthy();
        });

        const editor = ref.current?.getEditor();

        if (!editor) {
            throw new Error("the composer editor did not mount");
        }

        act(() => {
            screen.getByRole("textbox").focus();
            editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7, 12)));
        });

        await userEvent.setup().keyboard("x");

        expect(onChange).toHaveBeenLastCalledWith("hello x");
    });
});
