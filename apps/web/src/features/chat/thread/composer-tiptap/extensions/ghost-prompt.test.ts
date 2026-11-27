/**
 * The suggested next prompt as ghost text, in a real editor: Tab inserts it, Escape or typing dismisses it, and the
 * as-you-type controller's clear does not take it away.
 */
import { Editor } from "@tiptap/core";
import StarterKitExtension from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import GhostCompletion from "./ghost-completion";

const PROMPT = "Summarise the diff";

const created: Editor[] = [];

const createEditor = (): Editor => {
    const editor = new Editor({ extensions: [StarterKitExtension, GhostCompletion] });

    created.push(editor);

    return editor;
};

afterEach(() => {
    for (const editor of created) {
        editor.destroy();
    }

    created.length = 0;
    document.body.replaceChildren();
});

const ghostText = (editor: Editor): string | null => editor.view.dom.querySelector("[data-ghost-completion]")?.textContent ?? null;

const press = (editor: Editor, key: string): void => {
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
};

describe("the suggested next prompt", () => {
    it("shows as ghost text in an empty composer, and is not part of the draft", () => {
        const editor = createEditor();

        editor.commands.setSuggestedPrompt(PROMPT);

        expect(ghostText(editor)).toBe(PROMPT);
        expect(editor.getText()).toBe("");
    });

    it("Tab inserts it into the draft and the ghost goes", () => {
        const editor = createEditor();

        editor.commands.setSuggestedPrompt(PROMPT);
        press(editor, "Tab");

        expect(editor.getText()).toBe(PROMPT);
        expect(ghostText(editor)).toBeNull();
    });

    it("Right Arrow does not insert it: Tab alone takes the suggested prompt", () => {
        const editor = createEditor();

        editor.commands.setSuggestedPrompt(PROMPT);
        press(editor, "ArrowRight");

        expect(editor.getText()).toBe("");
        expect(ghostText(editor)).toBe(PROMPT);
    });

    it("Escape dismisses it, and the draft stays empty", () => {
        const editor = createEditor();

        editor.commands.setSuggestedPrompt(PROMPT);
        press(editor, "Escape");

        expect(ghostText(editor)).toBeNull();
        expect(editor.getText()).toBe("");
    });

    it("typing dismisses it", () => {
        const editor = createEditor();

        editor.commands.setSuggestedPrompt(PROMPT);
        editor.commands.insertContent("x");

        expect(ghostText(editor)).toBeNull();
    });

    it("the as-you-type controller clearing its own ghost leaves it in place", () => {
        const editor = createEditor();

        editor.commands.setSuggestedPrompt(PROMPT);
        editor.commands.setGhostCompletion(null);

        expect(ghostText(editor)).toBe(PROMPT);
    });

    it("Tab with no suggested prompt inserts nothing", () => {
        const editor = createEditor();

        press(editor, "Tab");

        expect(editor.getText()).toBe("");
    });
});
