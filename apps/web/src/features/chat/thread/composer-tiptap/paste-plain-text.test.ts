// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKitExtension from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import { composerCoreExtensionOptions, pastePlainText } from "./paste-plain-text";

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

describe(pastePlainText, () => {
    afterEach(() => {
        for (const editor of editors) {
            editor.destroy();
        }

        editors.length = 0;
    });

    it("replaces the selection made at paste time while the text is unchanged", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 1, 6);

        const atPaste = editor.state;

        select(editor, 7, 12);

        expect(pastePlainText(editor, "bye", atPaste)).toBe(true);
        expect(text(editor)).toBe("bye world");
    });

    it("leaves a selection made after an edit alone and hands the paste back", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 1, 6);

        const atPaste = editor.state;

        editor.view.dispatch(editor.state.tr.insertText("!", 12));
        select(editor, 7, 12);

        expect(pastePlainText(editor, "bye", atPaste)).toBe(false);
        expect(text(editor)).toBe("hello world!");
    });

    it("pastes over the current selection when no paste-time state is given, a paragraph per line", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 7, 12);

        expect(pastePlainText(editor, "a\n\nb")).toBe(true);
        expect(text(editor)).toBe("hello a\n\nb");
    });

    it("is an undo step of its own, apart from the typing just before it", () => {
        const editor = editorWith("<p>hello</p>");

        select(editor, 6, 6);
        editor.view.dispatch(editor.state.tr.insertText(" there"));

        expect(pastePlainText(editor, "X")).toBe(true);

        editor.commands.undo();

        expect(text(editor)).toBe("hello there");
    });

    it("gets back the same lines from a copy of the composer's own text", () => {
        const editor = editorWith("<p>one</p><p></p><p>two</p>");

        editor.commands.selectAll();

        const copied = editor.view.someProp("clipboardTextSerializer", (serialize) => serialize(editor.state.selection.content(), editor.view)) ?? "";

        expect(pastePlainText(editor, copied)).toBe(true);
        expect(text(editor)).toBe("one\n\ntwo");
    });
});
