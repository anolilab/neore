/**
 * QuoteChip: a quoted reply in the composer, shown as a chip with a link back to the reply. Anything typed after the
 * chip is the comment.
 *
 * The draft keeps the quote as text (`formatQuote`), and `renderText` gives that same text to the editor's `getText`,
 * so the draft and the editor agree. The composer's sync therefore never rebuilds the chip from plain text while the
 * user is typing. A draft written from outside the editor (dictation, a restore) does rebuild it, as plain quoted lines.
 */
import type { Editor } from "@tiptap/core";
import { mergeAttributes, Node } from "@tiptap/core";

import { textAfterRestore } from "@/features/chat/core/utils/composer-restore";
import { formatQuote } from "@/features/chat/core/utils/quote-selection";
import { scrollToMessage } from "@/features/chat/core/utils/scroll-to-message";
import { showWarning } from "@/lib/toast";

const EXCERPT_CHARS = 120;

const excerptOf = (text: string): string => {
    const flat = text.replaceAll(/\s+/gu, " ").trim();

    return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
};

export interface QuoteChipOptions {
    /** The link's label, and the notice when the quoted reply is not on screen. Translated by the composer. */
    labels: { goToReply: string; notOnScreen: string };
}

const QuoteChip = Node.create<QuoteChipOptions>({
    addAttributes() {
        return {
            messageId: { default: "" },
            text: { default: "" },
        };
    },

    addNodeView() {
        const { labels } = this.options;

        return ({ node }) => {
            const dom = document.createElement("div");
            const excerpt = document.createElement("span");
            const source = document.createElement("button");

            dom.dataset.quoteChip = "";
            dom.contentEditable = "false";
            dom.className = "bg-muted text-muted-foreground my-1 flex items-center gap-2 rounded-md border px-2 py-1 text-xs";
            excerpt.className = "min-w-0 truncate";
            excerpt.textContent = excerptOf(String(node.attrs.text ?? ""));
            source.type = "button";
            source.className = "text-primary shrink-0 underline-offset-2 hover:underline";
            source.textContent = labels.goToReply;
            source.addEventListener("click", () => {
                if (!scrollToMessage(String(node.attrs.messageId ?? ""))) {
                    showWarning(labels.notOnScreen);
                }
            });
            dom.appendChild(excerpt);
            dom.appendChild(source);

            return { dom };
        };
    },

    atom: true,

    group: "block",

    name: "quoteChip",

    parseHTML() {
        return [{ tag: "div[data-quote-chip]" }];
    },

    renderHTML({ HTMLAttributes }) {
        return ["div", mergeAttributes(HTMLAttributes, { "data-quote-chip": "" })];
    },

    renderText({ node }) {
        return formatQuote(String(node.attrs.text ?? ""));
    },

    addOptions() {
        return {
            labels: { goToReply: "Go to reply", notOnScreen: "The quoted reply is not on screen" },
        };
    },

    selectable: true,
});

export default QuoteChip;

/**
 * Adds a quote chip to the draft, followed by an empty line where the comment goes. An empty draft is replaced by the
 * chip; otherwise the chip is appended after the text.
 */
export const insertQuoteChip = (editor: Editor, quote: { messageId: string; text: string }): void => {
    const content = [{ attrs: { messageId: quote.messageId, text: quote.text }, type: "quoteChip" }, { type: "paragraph" }];

    if (editor.getText().trim() === "") {
        editor.commands.setContent({ content, type: "doc" });

        return;
    }

    editor.commands.insertContentAt(editor.state.doc.content.size, content);
};

/**
 * The draft after a quote restore. With the editor mounted, the chip goes in and the draft is the editor's text. Without
 * it (the request was taken before Tiptap created the editor), the quote is added to the draft as plain quoted lines.
 * The composer's sync puts that text into the editor when it mounts, so the selection is not lost; it is just not a chip.
 */
export const quoteRestoreDraft = (editor: Editor | null, quote: { messageId: string; text: string }, draft: string): string => {
    if (!editor) {
        return textAfterRestore(draft, { append: true, files: [], text: formatQuote(quote.text) });
    }

    insertQuoteChip(editor, quote);

    return editor.getText({ blockSeparator: "\n" });
};
