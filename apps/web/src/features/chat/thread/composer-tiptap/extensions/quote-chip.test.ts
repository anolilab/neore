import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import { formatQuote } from "@/features/chat/core/utils/quote-selection";

import QuoteChip, { insertQuoteChip } from "./quote-chip";

const labels = { goToReply: "Go to reply", notOnScreen: "Not on screen" };
const quoted = { messageId: "msg-4", text: "The first line\nthe second line" };

describe("the quote chip's text", () => {
    it("is the quoted lines as a Markdown blockquote, the same text the draft holds", () => {
        const renderChip = QuoteChip.config.renderText as unknown as ((props: { node: { attrs: Record<string, unknown> } }) => string) | undefined;

        expect(renderChip?.({ node: { attrs: { messageId: "msg-4", text: quoted.text } } })).toBe(formatQuote(quoted.text));
    });
});

describe("insertQuoteChip", () => {
    let editor: Editor | undefined;

    afterEach(() => {
        editor?.destroy();
        editor = undefined;
    });

    const createEditor = (content = ""): Editor => {
        editor = new Editor({ content, extensions: [StarterKit.configure({ blockquote: false }), QuoteChip.configure({ labels })] });

        return editor;
    };

    it("puts the chip in an empty draft, with a line after it for the comment", () => {
        const instance = createEditor();

        insertQuoteChip(instance, quoted);

        expect(instance.getJSON().content?.map((node) => node.type)).toEqual(["quoteChip", "paragraph"]);
        expect(instance.getText({ blockSeparator: "\n" })).toContain(formatQuote(quoted.text).trimEnd());
    });

    it("appends the chip after typed text, and the editor's text keeps the quote", () => {
        const instance = createEditor("Before the quote");

        insertQuoteChip(instance, quoted);

        expect(instance.getJSON().content?.map((node) => node.type)).toEqual(["paragraph", "quoteChip", "paragraph"]);
        expect(instance.getText({ blockSeparator: "\n" })).toContain(formatQuote(quoted.text).trimEnd());
    });
});
