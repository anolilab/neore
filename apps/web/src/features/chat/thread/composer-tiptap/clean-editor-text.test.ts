// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import StarterKitExtension from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import { cleanEditorText } from "./clean-editor-text";

const editors: Editor[] = [];

const editorWith = (content: string): Editor => {
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
});
