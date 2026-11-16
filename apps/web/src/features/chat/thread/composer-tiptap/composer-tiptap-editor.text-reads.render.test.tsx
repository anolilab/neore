/**
 * One keystroke, typed through the keyboard events ProseMirror handles, in the REAL composer editor reads its text from the change handler and from the ghost completion's
 * update and selection-change listeners. The text of one document is serialised once, however many of them ask.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/core";
import { createRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ComposerTiptapEditorRef } from "./composer-tiptap-editor";

const serialised = vi.hoisted(() => {
    return { count: 0 };
});

// Counts the serialisations `readComposerText` makes; `Editor#getText` is counted with a spy below.
vi.mock("@tiptap/core", async (importOriginal) => {
    const original = await importOriginal<typeof import("@tiptap/core")>();

    return {
        ...original,
        getText: (...parameters: Parameters<typeof original.getText>) => {
            serialised.count += 1;

            return original.getText(...parameters);
        },
    };
});

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

describe("ComposerTiptapEditor text reads", () => {
    // ProseMirror scrolls the selection into view on every edit; jsdom has no layout for ranges.
    beforeAll(() => {
        const emptyRect = () => new DOMRect();

        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = emptyRect;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("serialises the document once per keystroke", async () => {
        const ref = createRef<ComposerTiptapEditorRef>();
        const onChange = vi.fn();

        render(<ComposerTiptapEditor onChange={onChange} onSubmit={() => {}} ref={ref} requestCompletion={requestCompletion} value="" />);
        await waitFor(() => {
            expect(ref.current?.getEditor()).toBeTruthy();
        });

        const user = userEvent.setup();

        // Focused directly: a click asks for layout (`elementFromPoint`) that jsdom does not have.
        act(() => {
            screen.getByRole("textbox").focus();
        });

        const editorGetText = vi.spyOn(Editor.prototype, "getText");

        serialised.count = 0;

        await user.keyboard("a");

        expect(onChange).toHaveBeenLastCalledWith("a");
        expect(serialised.count + editorGetText.mock.calls.length).toBe(1);
    });
});
