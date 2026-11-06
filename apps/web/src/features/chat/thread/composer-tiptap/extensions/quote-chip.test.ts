import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import { onComposerRestore, requestComposerRestore } from "@/features/chat/core/utils/composer-restore";
import { formatQuote } from "@/features/chat/core/utils/quote-selection";

import { plainTextToHtml } from "../plain-text";
import QuoteChip, { insertQuoteChip, quoteRestoreDraft } from "./quote-chip";

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

describe("quoteRestoreDraft", () => {
    let editor: Editor | undefined;

    afterEach(() => {
        editor?.destroy();
        editor = undefined;
    });

    it("keeps the quote in the draft as plain quoted lines while the editor is not mounted", () => {
        expect(quoteRestoreDraft(null, quoted, "Before")).toBe(`Before\n${formatQuote(quoted.text)}`);
    });

    it("keeps a request taken before the editor mounts, then adds a chip once it is mounted", () => {
        // Tiptap creates the editor after the composer subscribes, so the first request is taken while it is unavailable.
        let mounted: Editor | null = null;
        let draft = "Before";

        const unsubscribe = onComposerRestore((payload) => {
            if (payload.quote) {
                draft = quoteRestoreDraft(mounted, payload.quote, draft);
            }
        });

        requestComposerRestore({ append: true, files: [], quote: quoted, text: "" });

        expect(draft).toBe(`Before\n${formatQuote(quoted.text)}`);

        // The composer mounts the editor with the draft (its sync effect uses the same conversion).
        editor = new Editor({ content: plainTextToHtml(draft), extensions: [StarterKit.configure({ blockquote: false }), QuoteChip.configure({ labels })] });
        mounted = editor;

        expect(mounted.getText({ blockSeparator: "\n" })).toContain("The first line");

        requestComposerRestore({ append: true, files: [], quote: { messageId: "msg-5", text: "A later selection" }, text: "" });
        unsubscribe();

        expect(mounted.getJSON().content?.some((node) => node.type === "quoteChip")).toBe(true);
        expect(draft).toBe(mounted.getText({ blockSeparator: "\n" }));
    });
});
