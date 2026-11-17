// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKitExtension from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import { composerCoreExtensionOptions } from "./paste-plain-text";
import { wrapSelection, wrapSelectionOnTextInput } from "./wrap-selection";

const editors: Editor[] = [];

const editorWith = (content: string): Editor => {
    const editor = new Editor({ content, coreExtensionOptions: composerCoreExtensionOptions, extensions: [StarterKitExtension] });

    editors.push(editor);

    return editor;
};

const select = (editor: Editor, from: number, to: number): void => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
};

const text = (editor: Editor): string => editor.getText({ blockSeparator: "\n" });

const selectedText = (editor: Editor): string => {
    const { from, to } = editor.state.selection;

    return editor.state.doc.textBetween(from, to);
};

describe("wrapSelectionOnTextInput", () => {
    afterEach(() => {
        for (const editor of editors) {
            editor.destroy();
        }

        editors.length = 0;
    });

    it.each([
        ["`", "`world`"],
        ["*", "**world**"],
        ["_", "_world_"],
    ])("wraps the selection in the delimiter typed %s", (typed, expected) => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 7, 12);

        expect(wrapSelectionOnTextInput(editor.view, 7, 12, typed)).toBe(true);
        expect(text(editor)).toBe(`hello ${expected}`);
    });

    it("keeps the wrapped text selected, so a second marker wraps it again", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 7, 12);
        wrapSelectionOnTextInput(editor.view, 7, 12, "*");

        expect(selectedText(editor)).toBe("world");

        const { from, to } = editor.state.selection;

        expect(wrapSelectionOnTextInput(editor.view, from, to, "_")).toBe(true);
        expect(text(editor)).toBe("hello **_world_**");
    });

    it("makes the wrap one step to undo", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 7, 12);
        wrapSelectionOnTextInput(editor.view, 7, 12, "`");
        editor.commands.undo();

        expect(text(editor)).toBe("hello world");
    });

    it("leaves typing alone when nothing is selected", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 12, 12);

        expect(wrapSelectionOnTextInput(editor.view, 12, 12, "*")).toBe(false);
        expect(text(editor)).toBe("hello world");
    });

    it("leaves a character that is no marker alone, even over a selection", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 7, 12);

        expect(wrapSelectionOnTextInput(editor.view, 7, 12, "a")).toBe(false);
    });

    it("leaves a selection across two blocks alone, so their break is not lost", () => {
        const editor = editorWith("<p>hello</p><p>world</p>");

        expect(wrapSelectionOnTextInput(editor.view, 3, 10, "*")).toBe(false);
        expect(text(editor)).toBe("hello\nworld");
    });

    it("leaves a selection that holds a line break alone", () => {
        const editor = editorWith("<p>ab<br>cd</p>");

        expect(wrapSelectionOnTextInput(editor.view, 2, 5, "_")).toBe(false);
    });

    it("leaves composition text alone, so an IME commit still replaces the selection", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 7, 12);
        Object.defineProperty(editor.view, "composing", { configurable: true, get: () => true });

        expect(wrapSelectionOnTextInput(editor.view, 7, 12, "*")).toBe(false);
    });
});

describe("wrapSelection", () => {
    afterEach(() => {
        for (const editor of editors) {
            editor.destroy();
        }

        editors.length = 0;
    });

    it("returns no transaction for a marker over an empty selection", () => {
        const editor = editorWith("<p>hello</p>");

        expect(wrapSelection(editor.state, 3, 3, "`")).toBeNull();
    });

    it("returns a transaction that selects only the wrapped text", () => {
        const editor = editorWith("<p>hello world</p>");
        const transaction = wrapSelection(editor.state, 1, 6, "_");

        if (transaction === null) {
            throw new Error("expected a transaction");
        }

        editor.view.dispatch(transaction);

        expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe("hello");
        expect(text(editor)).toBe("_hello_ world");
    });
});
