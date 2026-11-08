/**
 * QuoteChip: a quoted reply in the composer, shown as a chip with a link back to the reply. Anything typed after the
 * chip is the comment.
 *
 * The draft keeps the quote as text (`formatQuote`), and `renderText` gives that same text to the editor's `getText`,
 * so the draft and the editor agree. The composer's sync therefore never rebuilds the chip from plain text while the
 * user is typing. A draft written from outside the editor (dictation, a restore) does rebuild it, as plain quoted lines.
 */
import { stripHiddenText } from "@neore/ai/utils";
import type { Editor } from "@tiptap/core";
import { mergeAttributes, Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";

import { textAfterRestore } from "@/features/chat/core/utils/composer-restore";
import { formatQuote } from "@/features/chat/core/utils/quote-selection";
import { scrollToMessage } from "@/features/chat/core/utils/scroll-to-message";

import { plainTextToHtml } from "../plain-text";

const EXCERPT_CHARS = 120;

/** A pasted quote past the composer's long-paste limits is not made a chip, whose excerpt would hide most of it. */
const MAX_PASTED_QUOTE_CHARS = 500;
const MAX_PASTED_QUOTE_LINES = 10;

/** The quote as the draft keeps it: without the hidden characters the composer strips from every draft. */
const cleanQuote = (text: string): string => stripHiddenText(text).text;

/** Elements a page can use to put text in the HTML that nobody sees, by what they are or by an attribute. */
const HIDDEN_ELEMENTS = '[hidden], [aria-hidden="true"], script, style, template';

/** Inline style values that hide an element's text, by property. */
const HIDING_VALUES: ReadonlyArray<[property: string, values: ReadonlyArray<string>]> = [
    ["display", ["none"]],
    ["visibility", ["hidden", "collapse"]],
    ["content-visibility", ["hidden"]],
];

/**
 * Whether a page hid this element: one of the elements above, or an inline style that hides it. The style is read as parsed
 * declarations, so `display: block; background: none` is visible, as a reader sees it. A value this cannot resolve here (a
 * `var()`, `attr()` or `env()`), or a style on an element without one to read, counts as hidden: the guard fails closed.
 */
const isHidden = (element: Element): boolean => {
    if (element.matches(HIDDEN_ELEMENTS)) {
        return true;
    }

    const { style } = element as Partial<HTMLElement>;

    if (style === undefined) {
        return element.hasAttribute("style");
    }

    return HIDING_VALUES.some(([property, values]) => {
        const value = style.getPropertyValue(property).trim().toLowerCase();

        return values.includes(value) || value.includes("(");
    });
};

/** The text a reader sees in one quoted line: nothing when the line itself is hidden, and its hidden descendants are left out. */
const visibleText = (line: Element): string => {
    if (isHidden(line)) {
        return "";
    }

    const copy = line.cloneNode(true) as Element;

    for (const descendant of copy.querySelectorAll("*")) {
        if (isHidden(descendant)) {
            descendant.remove();
        }
    }

    // A `<br>` inside a quoted line is a line break the reader sees.
    for (const lineBreak of copy.querySelectorAll("br")) {
        lineBreak.replaceWith("\n");
    }

    return copy.textContent ?? "";
};

/**
 * A pasted chip's quote, read from its visible quoted lines, never from an attribute the pasting page could fill unseen. A chip
 * the page hid as a whole has no visible quote.
 */
const visibleQuote = (element: HTMLElement): string =>
    isHidden(element)
        ? ""
        : cleanQuote(
              [...element.querySelectorAll(":scope > blockquote")]
                  .filter((blockquote) => !isHidden(blockquote))
                  .flatMap((blockquote) => Array.from(blockquote.querySelectorAll(":scope > p"), visibleText))
                  .join("\n")
                  .trim(),
          );

/**
 * A chip's draft text: the quote, ending its last line. The block separator before the comment paragraph makes the one blank
 * line `formatQuote` ends with, so the draft matches a quote added as plain text.
 */
const chipText = (node: ProseMirrorNode): string => `${formatQuote(String(node.attrs.text ?? "")).trimEnd()}\n`;

const excerptOf = (text: string): string => {
    const flat = text.replaceAll(/\s+/gu, " ").trim();

    return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
};

export interface QuoteChipLabels {
    goToReply: string;
}

export interface QuoteChipOptions {
    /**
     * The link's label. A getter, so each read is in the current
     * locale: the composer's editor is not recreated on a locale switch, and `refreshQuoteChipLabels` repaints the chips
     * already drawn.
     */
    labels: () => QuoteChipLabels;
}

/** Repaints each drawn chip's link label, for chips drawn before a locale change. */
const repaints = new WeakMap<HTMLElement, () => void>();

export const refreshQuoteChipLabels = (root: HTMLElement): void => {
    for (const chip of root.querySelectorAll<HTMLElement>(":scope [data-quote-chip]")) {
        repaints.get(chip)?.();
    }
};

const QuoteChip = Node.create<QuoteChipOptions>({
    addAttributes() {
        return {
            messageId: {
                default: "",
                parseHTML: (element) => element.dataset.messageId ?? "",
                renderHTML: ({ messageId }) => {
                    return { "data-message-id": String(messageId ?? "") };
                },
            },
            text: {
                default: "",
                parseHTML: visibleQuote,
                // The quoted lines are in the HTML body (`renderHTML` below); that is where a paste reads them from.
                renderHTML: () => {
                    return {};
                },
            },
        };
    },

    addNodeView() {
        const { labels } = this.options;

        return ({ node }) => {
            const dom = document.createElement("div");
            const excerpt = document.createElement("span");
            const fullText = document.createElement("span");
            const source = document.createElement("button");
            const paint = (): void => {
                const label = labels().goToReply;

                if (source.textContent !== label) {
                    source.textContent = label;
                }
            };

            dom.dataset.quoteChip = "";
            dom.contentEditable = "false";
            dom.className = "bg-muted text-muted-foreground my-1 flex items-center gap-2 rounded-md border px-2 py-1 text-xs";
            excerpt.className = "min-w-0 truncate";
            excerpt.textContent = excerptOf(String(node.attrs.text ?? ""));
            // The excerpt is for the eye; a screen reader reads the whole quote instead.
            excerpt.setAttribute("aria-hidden", "true");
            fullText.className = "sr-only";
            fullText.textContent = String(node.attrs.text ?? "");
            source.type = "button";
            // 44px on a touch screen (WCAG 2.5.5), the chip's own size on a pointer.
            source.className =
                "text-primary inline-flex shrink-0 items-center underline-offset-2 hover:underline pointer-coarse:min-h-11 pointer-coarse:min-w-11";
            paint();
            source.addEventListener("click", () => {
                // The list mounts a windowed-out reply and pages in an older one, and says so when it is not in the thread.
                scrollToMessage(String(node.attrs.messageId ?? ""));
            });
            dom.appendChild(fullText);
            dom.appendChild(excerpt);
            dom.appendChild(source);
            repaints.set(dom, paint);

            // Keys and clicks on the link are the button's own: without this, Enter on the focused link reaches the
            // editor's keymap and sends the draft instead of following the link.
            return { dom, stopEvent: (event: Event) => event.target instanceof globalThis.Node && source.contains(event.target) };
        };
    },

    /** The quote as leaf text, so `doc.textBetween` (cursor and paste offsets) counts the same text the draft holds. */
    extendNodeSchema(extension) {
        return extension.name === "quoteChip" ? { leafText: chipText } : {};
    },

    atom: true,

    group: "block",

    name: "quoteChip",

    parseHTML() {
        return [
            {
                // A long quote is pasted as its plain lines instead, so all of it is on screen to read before it is sent.
                getAttrs: (element) => {
                    const text = visibleQuote(element);

                    return text !== "" && text.length <= MAX_PASTED_QUOTE_CHARS && text.split("\n").length <= MAX_PASTED_QUOTE_LINES ? null : false;
                },
                tag: "div[data-quote-chip]",
            },
            {
                // The long quote the rule above passes on keeps its quote markers, as the draft text of a chip has them.
                // A chip with no visible quote (hidden as a whole) leaves an empty line, not a lone quote marker.
                getContent: (element, schema) => {
                    const quote = visibleQuote(element as HTMLElement);

                    if (quote === "") {
                        return Fragment.empty;
                    }

                    const lines = formatQuote(quote).trimEnd().split("\n");
                    const lineBreak = schema.nodes.hardBreak;

                    return Fragment.fromArray(
                        lines.flatMap((line, index) => {
                            const text = line === "" ? [] : [schema.text(line)];

                            return index === 0 || !lineBreak ? text : [lineBreak.create(), ...text];
                        }),
                    );
                },
                node: "paragraph",
                tag: "div[data-quote-chip]",
            },
        ];
    },

    /**
     * The quoted lines are part of the HTML, so a copy into a rich-text app pastes them (the node view is not serialised).
     * The reply id stays as a data attribute, so pasting the HTML back into the composer rebuilds the chip from the lines.
     */
    renderHTML({ HTMLAttributes, node }) {
        const lines = String(node.attrs.text ?? "")
            .trim()
            .replaceAll("\r\n", "\n")
            .split("\n");

        return ["div", mergeAttributes(HTMLAttributes, { "data-quote-chip": "" }), ["blockquote", {}, ...lines.map((line) => ["p", {}, line])]];
    },

    renderText({ node }) {
        return chipText(node);
    },

    addOptions() {
        return {
            labels: () => {
                return { goToReply: "Go to reply" };
            },
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
    const content = [{ attrs: { messageId: quote.messageId, text: cleanQuote(quote.text) }, type: "quoteChip" }, { type: "paragraph" }];

    if (editor.getText().trim() === "") {
        editor.commands.setContent({ content, type: "doc" });

        return;
    }

    // The chip takes the place of trailing empty lines, so a draft ending in a newline does not gain a blank line before it.
    const { doc } = editor.state;
    let from = doc.content.size;

    for (let index = doc.childCount - 1; index > 0; index -= 1) {
        const child = doc.child(index);

        // An empty line is a paragraph with nothing in it, or only a line break (as the composer writes one). The empty line
        // right after a chip is that chip's comment line, and stays.
        const isEmptyLine =
            child.type.name === "paragraph" && child.textContent === "" && child.content.content.every((node) => node.type.name === "hardBreak");

        if (!isEmptyLine || doc.child(index - 1).type.name === "quoteChip") {
            break;
        }

        from -= child.nodeSize;
    }

    editor.commands.insertContentAt({ from, to: doc.content.size }, content);
};

/**
 * The draft after a quote restore. With the editor mounted, the chip goes in and the draft is the editor's text. Without
 * it (the request was taken before Tiptap created the editor), the quote is added to the draft as plain quoted lines.
 * The composer's sync puts that text into the editor when it mounts, so the selection is not lost; it is just not a chip.
 */
export const quoteRestoreDraft = (editor: Editor | null, quote: { messageId: string; text: string }, draft: string): string => {
    if (!editor) {
        return textAfterRestore(draft, { append: true, files: [], text: formatQuote(cleanQuote(quote.text)) });
    }

    // The draft can be newer than the editor: an outside change (dictation) reaches the store before the composer's sync
    // copies it into the editor. Bring the editor up to the draft first, so the quote is added to what the user sees
    // rather than to stale editor content that would then replace the newer text.
    if (editor.getText({ blockSeparator: "\n" }) !== draft) {
        editor.commands.setContent(plainTextToHtml(draft), { emitUpdate: false });
    }

    insertQuoteChip(editor, quote);

    return editor.getText({ blockSeparator: "\n" });
};
