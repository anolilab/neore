// @vitest-environment jsdom

import type { Content } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import StarterKitExtension from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import { cleanEditorText } from "./clean-editor-text";

const editors: Editor[] = [];

const editorWith = (content: Content): Editor => {
    const editor = new Editor({ content, extensions: [StarterKitExtension] });

    editors.push(editor);

    return editor;
};

describe(cleanEditorText, () => {
    afterEach(() => {
        for (const editor of editors) {
            editor.destroy();
        }

        editors.length = 0;
    });

    it("takes hidden characters out of the document, so a later read finds none to count again", () => {
        const editor = editorWith("<p>hi\u{E0041}\u{202E} there</p><p>x</p>");

        cleanEditorText(editor);

        expect(editor.getText({ blockSeparator: "\n" })).toBe("hi there\nx");
    });

    it("is not an undo step of its own: Undo reverses the person's edit, not the cleanup", () => {
        const editor = editorWith("<p>hi\u{E0041} there</p>");
        let history: unknown;

        editor.on("transaction", ({ transaction }) => {
            history = transaction.getMeta("addToHistory");
        });

        cleanEditorText(editor);

        expect(history).toBe(false);
    });

    it("empties a document that held nothing but hidden characters", () => {
        const editor = editorWith("<p>\u{E0041}\u{E0042}</p>");

        cleanEditorText(editor);

        expect(editor.isEmpty).toBe(true);
    });

    it("leaves a clean document alone", () => {
        const editor = editorWith("<p>hello 👍</p>");
        const before = editor.state.doc;

        cleanEditorText(editor);

        expect(editor.state.doc).toBe(before);
    });

    it("keeps runs of spaces, tabs and leading and trailing spaces", () => {
        const editor = editorWith({ content: [{ content: [{ text: "  a   b\t\u{E0041}c  ", type: "text" }], type: "paragraph" }], type: "doc" });

        cleanEditorText(editor);

        expect(editor.getText({ blockSeparator: "\n" })).toBe("  a   b\tc  ");
    });

    it("moves the caret back by the removed character when it was before the caret", () => {
        const editor = editorWith("<p>ab\u{202E}cd</p>");

        editor.commands.setTextSelection(5);
        cleanEditorText(editor);

        expect(editor.state.selection.from).toBe(4);
        expect(editor.state.doc.textBetween(1, editor.state.selection.from)).toBe("abc");
    });

    it("leaves the caret alone when the removed character is after it", () => {
        const editor = editorWith("<p>ab\u{202E}cd</p>");

        editor.commands.setTextSelection(2);
        cleanEditorText(editor);

        expect(editor.state.selection.from).toBe(2);
    });

    it("removes an astral tag character whole, moving the caret by its two units", () => {
        const editor = editorWith("<p>a\u{E0041}bc</p>");

        editor.commands.setTextSelection(5);
        cleanEditorText(editor);

        expect(editor.getText()).toBe("abc");
        expect(editor.state.selection.from).toBe(3);
    });
});
