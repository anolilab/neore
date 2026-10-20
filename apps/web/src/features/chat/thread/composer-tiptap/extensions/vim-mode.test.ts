// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import StarterKitExtension from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import VimMode, { refreshVimMode } from "./vim-mode";

const editors: Editor[] = [];

/** A composer editor with Vim on; Escape leaves insert mode for normal mode. */
const vimEditor = (): Editor => {
    const editor = new Editor({
        content: "<p>draft</p>",
        extensions: [StarterKitExtension, VimMode.configure({ isEnabled: () => true })],
    });

    editors.push(editor);

    return editor;
};

const pressEscape = (editor: Editor): void => {
    editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, new KeyboardEvent("keydown", { key: "Escape" })));
};

describe(refreshVimMode, () => {
    afterEach(() => {
        for (const editor of editors) {
            editor.destroy();
        }

        editors.length = 0;
    });

    it("returns an editor in normal mode to insert mode, so the next text is typed, not read as commands", () => {
        const editor = vimEditor();

        pressEscape(editor);
        expect(editor.view.dom.classList.contains("vim-normal")).toBe(true);

        refreshVimMode(editor.view);

        expect(editor.view.dom.classList.contains("vim-normal")).toBe(false);
    });
});
