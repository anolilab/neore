// @vitest-environment jsdom

/** An accepted completion is the model's text, not the person's: the composer learns of it (`onAccept`) once it is in. */
import { Editor } from "@tiptap/core";
import StarterKitExtension from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import GhostCompletion from "./ghost-completion";

const editors: Editor[] = [];

const editorWith = (onAccept: () => void): Editor => {
    const editor = new Editor({ content: "<p>hello</p>", extensions: [StarterKitExtension, GhostCompletion.configure({ onAccept })] });

    editors.push(editor);
    editor.commands.focus("end");

    return editor;
};

const pressRight = (editor: Editor): void => {
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
};

describe("GhostCompletion accept", () => {
    afterEach(() => {
        for (const editor of editors) {
            editor.destroy();
        }

        editors.length = 0;
    });

    it("tells the composer once the accepted text is in the document", () => {
        const onAccept = vi.fn<(text: string) => void>();
        const editor: Editor = editorWith(() => onAccept(editor.getText()));

        editor.commands.setGhostCompletion(" there");
        pressRight(editor);

        expect(onAccept).toHaveBeenCalledOnce();
        expect(onAccept).toHaveBeenCalledWith("hello there");
    });

    it("tells it nothing when Right Arrow only moves the caret", () => {
        const onAccept = vi.fn<() => void>();
        const editor = editorWith(onAccept);

        pressRight(editor);

        expect(onAccept).not.toHaveBeenCalled();
        expect(editor.getText()).toBe("hello");
    });
});
