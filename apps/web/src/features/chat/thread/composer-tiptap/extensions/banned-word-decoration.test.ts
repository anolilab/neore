import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import BannedWordDecoration, { bannedWordPluginKey } from "./banned-word-decoration";
import QuoteChip from "./quote-chip";

const labels = () => {
    return { goToReply: "Go to reply", notOnScreen: "Not on screen" };
};

describe("banned-word decorations", () => {
    let editor: Editor | undefined;

    afterEach(() => {
        editor?.destroy();
        editor = undefined;
    });

    const create = (): Editor => {
        editor = new Editor({
            content: "",
            extensions: [StarterKit.configure({ blockquote: false }), QuoteChip.configure({ labels }), BannedWordDecoration],
        });

        return editor;
    };

    // The matches arrive from the server as offsets into the draft text, which is what `getText` returns.
    const highlightFor = (instance: Editor, word: string): void => {
        const draft = instance.getText({ blockSeparator: "\n" });
        const startIndex = draft.indexOf(word);

        instance.commands.setBannedWordMatches([{ endIndex: startIndex + word.length, startIndex, word }]);
    };

    const highlighted = (instance: Editor): string[] =>
        (bannedWordPluginKey.getState(instance.state)?.decorations.find() ?? []).map((decoration) =>
            instance.state.doc.textBetween(decoration.from, decoration.to),
        );

    it("highlights the word in plain text", () => {
        const instance = create();

        instance.commands.setContent("<p>say badword here</p>");
        highlightFor(instance, "badword");

        expect(highlighted(instance)).toEqual(["badword"]);
    });

    it("highlights a banned word typed after a quote chip, at the place the draft text puts it", () => {
        const instance = create();

        instance.commands.setContent({
            content: [
                { attrs: { messageId: "msg-1", text: "A quoted line\nand another" }, type: "quoteChip" },
                { content: [{ text: "say badword here", type: "text" }], type: "paragraph" },
            ],
            type: "doc",
        });
        highlightFor(instance, "badword");

        expect(highlighted(instance)).toEqual(["badword"]);
    });

    it("does not highlight words that are only inside a quote chip", () => {
        const instance = create();

        instance.commands.setContent({
            content: [
                { attrs: { messageId: "msg-1", text: "A quoted line" }, type: "quoteChip" },
                { content: [{ text: "comment", type: "text" }], type: "paragraph" },
            ],
            type: "doc",
        });
        highlightFor(instance, "quoted");

        expect(highlighted(instance)).toEqual([]);
    });
});
