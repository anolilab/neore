// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKitExtension from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import { appendPlainText, composerCoreExtensionOptions, pastePlainText } from "./paste-plain-text";

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

describe(appendPlainText, () => {
    afterEach(() => {
        for (const editor of editors) {
            editor.destroy();
        }

        editors.length = 0;
    });

    it("adds the lines after the last block and leaves the blocks before it as they are", () => {
        const editor = editorWith("<blockquote><p>quoted</p></blockquote><p>draft</p>");

        // The caret was left in the quote, as when the draft changed while the paste converted.
        select(editor, 2, 2);

        expect(appendPlainText(editor, "\n\npasted")).toBe(true);
        // Typing goes on after the paste, not where the caret was.
        editor.view.dispatch(editor.state.tr.insertText("!"));
        expect(editor.state.doc.lastChild?.textContent).toBe("pasted!");
        editor.view.dispatch(editor.state.tr.delete(editor.state.selection.from - 1, editor.state.selection.from));
        expect(editor.state.doc.firstChild?.type.name).toBe("blockquote");
        expect(editor.state.doc.childCount).toBe(4);
        expect(editor.state.doc.child(1).textContent).toBe("draft");
        expect(editor.state.doc.child(2).textContent).toBe("");
        expect(editor.state.doc.lastChild?.textContent).toBe("pasted");
    });

    it("puts the first line in a draft's trailing empty line, as appending to its text does", () => {
        // `quoted\n`: the draft ends on an empty line, so the paste is appended with no break of its own.
        const editor = editorWith("<blockquote><p>quoted</p></blockquote><p></p>");

        expect(appendPlainText(editor, "pasted\nmore")).toBe(true);
        expect(editor.state.doc.firstChild?.type.name).toBe("blockquote");
        expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n")).toBe("quoted\npasted\nmore");
        expect(editor.state.doc.childCount).toBe(3);
    });

    it("puts a first line with no text block to end in a paragraph after the block, which it leaves as it is", () => {
        const editor = editorWith("<p>draft</p><hr>");

        expect(appendPlainText(editor, "pasted")).toBe(true);
        expect(editor.state.doc.child(1).type.name).toBe("horizontalRule");
        expect(editor.state.doc.childCount).toBe(3);
        expect(editor.state.doc.lastChild?.textContent).toBe("pasted");

        // A first line that is only a break is the block's own end.
        const other = editorWith("<p>draft</p><hr>");

        expect(appendPlainText(other, "\npasted")).toBe(true);
        expect(other.state.doc.childCount).toBe(3);
        expect(other.state.doc.lastChild?.textContent).toBe("pasted");
    });

    it("takes nothing into an editor that is not editable, nor does a paste", () => {
        const editor = editorWith("<p>draft</p>");

        editor.setEditable(false);

        expect(appendPlainText(editor, "pasted")).toBe(false);
        expect(pastePlainText(editor, "pasted")).toBe(false);
        expect(text(editor)).toBe("draft");
    });
});
