import { setupI18n } from "@lingui/core";
import { Editor, Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { onComposerRestore, requestComposerRestore } from "@/features/chat/core/utils/composer-restore";
import { formatQuote } from "@/features/chat/core/utils/quote-selection";
import { showWarning } from "@/lib/toast";

import { plainTextToHtml } from "../plain-text";
import QuoteChip, { insertQuoteChip, quoteRestoreDraft, refreshQuoteChipLabels } from "./quote-chip";

vi.mock("@/lib/toast", () => {
    return { showWarning: vi.fn() };
});

const labels = () => {
    return { goToReply: "Go to reply", notOnScreen: "Not on screen" };
};
const quoted = { messageId: "msg-4", text: "The first line\nthe second line" };

/** The chip's draft text is the quote as a blockquote, then the separator before the comment paragraph. */
const quotedDraft = "> The first line\n> the second line\n\n";

describe("the quote chip's text", () => {
    it("is the quoted lines as a Markdown blockquote, the same text the draft holds", () => {
        const renderChip = QuoteChip.config.renderText as unknown as ((props: { node: { attrs: Record<string, unknown> } }) => string) | undefined;

        expect(renderChip?.({ node: { attrs: { messageId: "msg-4", text: quoted.text } } })).toBe(quotedDraft);
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
        // The chip's quote, then the comment paragraph's separator: no text before the chip, an empty line after it.
        expect(instance.getText({ blockSeparator: "\n" })).toBe(`${quotedDraft}\n`);
    });

    it("appends the chip after typed text, and the editor's text keeps the quote", () => {
        const instance = createEditor("Before the quote");

        insertQuoteChip(instance, quoted);

        expect(instance.getJSON().content?.map((node) => node.type)).toEqual(["paragraph", "quoteChip", "paragraph"]);
        expect(instance.getText({ blockSeparator: "\n" })).toBe(`Before the quote\n${quotedDraft}\n`);
        // Cursor and paste offsets come from `textBetween`, so it has to count the chip's text the same way.
        expect(instance.state.doc.textBetween(0, instance.state.doc.content.size, "\n")).toBe(instance.getText({ blockSeparator: "\n" }));
    });
});

describe("the quote chip's clipboard", () => {
    let editor: Editor | undefined;

    afterEach(() => {
        editor?.destroy();
        editor = undefined;
    });

    const chipEditor = (): Editor => {
        editor = new Editor({
            content: { content: [{ attrs: { messageId: quoted.messageId, text: quoted.text }, type: "quoteChip" }], type: "doc" },
            extensions: [StarterKit.configure({ blockquote: false }), QuoteChip.configure({ labels })],
        });

        return editor;
    };

    it("copies the quoted lines into the HTML clipboard format, so a rich-text paste shows them", () => {
        const instance = chipEditor();
        const { dom } = instance.view.serializeForClipboard(instance.state.doc.slice(0, instance.state.doc.content.size));

        expect(new XMLSerializer().serializeToString(dom)).toContain("<blockquote><p>The first line</p><p>the second line</p></blockquote>");
    });

    it("copies the quote into the plain-text clipboard format too", () => {
        const instance = chipEditor();
        const { text } = instance.view.serializeForClipboard(instance.state.doc.slice(0, instance.state.doc.content.size));

        expect(text).toContain("> The first line\n> the second line");
    });

    it("pastes the copied HTML back as a chip with the same reply and text", () => {
        const instance = chipEditor();
        const { dom } = instance.view.serializeForClipboard(instance.state.doc.slice(0, instance.state.doc.content.size));

        const pasted = new Editor({
            content: new XMLSerializer().serializeToString(dom),
            extensions: [StarterKit.configure({ blockquote: false }), QuoteChip.configure({ labels })],
        });

        try {
            expect(pasted.getJSON().content?.[0]).toMatchObject({ attrs: { messageId: quoted.messageId, text: quoted.text }, type: "quoteChip" });
        } finally {
            pasted.destroy();
        }
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

describe("the link back to the quoted reply", () => {
    let editor: Editor | undefined;

    afterEach(() => {
        editor?.destroy();
        editor = undefined;
        document.body.replaceChildren();
    });

    it("moves focus to the quoted reply when the link is activated", () => {
        const reply = document.createElement("div");

        reply.dataset.messageId = "msg-7";
        reply.scrollIntoView = vi.fn();
        document.body.appendChild(reply);

        editor = new Editor({
            content: { content: [{ attrs: { messageId: "msg-7", text: "A line" }, type: "quoteChip" }], type: "doc" },
            extensions: [StarterKit.configure({ blockquote: false }), QuoteChip.configure({ labels })],
        });

        editor.view.dom.querySelector<HTMLButtonElement>(":scope [data-quote-chip] button")?.click();

        expect(document.activeElement).toBe(reply);
    });

    it("keeps Enter on the focused link from reaching the editor, so it does not send the draft", () => {
        const submit = vi.fn(() => true);
        const SubmitOnEnter = Extension.create({
            addKeyboardShortcuts() {
                return { Enter: submit };
            },
        });

        editor = new Editor({
            content: { content: [{ attrs: { messageId: "msg-7", text: "A line" }, type: "quoteChip" }], type: "doc" },
            extensions: [StarterKit.configure({ blockquote: false }), QuoteChip.configure({ labels }), SubmitOnEnter],
        });

        const link = editor.view.dom.querySelector<HTMLButtonElement>(":scope [data-quote-chip] button");

        link?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));

        expect(submit).not.toHaveBeenCalled();
    });
});

describe("quoteRestoreDraft when the draft changed before the editor synced", () => {
    let editor: Editor | undefined;

    afterEach(() => {
        editor?.destroy();
        editor = undefined;
    });

    it("adds the quote to the newer draft, not to the editor's stale text", () => {
        editor = new Editor({
            content: plainTextToHtml("Stale editor text"),
            extensions: [StarterKit.configure({ blockquote: false }), QuoteChip.configure({ labels })],
        });

        // Dictation wrote this to the draft store; the editor's sync has not run yet.
        const draft = "Dictated words the editor has not seen";
        const result = quoteRestoreDraft(editor, quoted, draft);

        expect(result.startsWith(`${draft}\n`)).toBe(true);
        expect(result).not.toContain("Stale editor text");
        expect(result).toContain(formatQuote(quoted.text).trimEnd());
        expect(editor.getJSON().content?.map((node) => node.type)).toEqual(["paragraph", "quoteChip", "paragraph"]);
    });

    it("leaves an editor that already matches the draft, chips included, as it is", () => {
        editor = new Editor({
            content: { content: [{ attrs: { messageId: "msg-1", text: "Earlier" }, type: "quoteChip" }, { type: "paragraph" }], type: "doc" },
            extensions: [StarterKit.configure({ blockquote: false }), QuoteChip.configure({ labels })],
        });
        const draft = editor.getText({ blockSeparator: "\n" });

        quoteRestoreDraft(editor, quoted, draft);

        expect(editor.getJSON().content?.map((node) => node.type)).toEqual(["quoteChip", "paragraph", "quoteChip", "paragraph"]);
    });
});

describe("the quote chip's labels after an in-place locale switch", () => {
    let editor: Editor | undefined;
    const i18n = setupI18n({ locale: "en", messages: {} });
    // Through an alias, so the catalog extractor does not take these test-only ids into the app's catalogs.
    const translate = (id: string, message: string): string => i18n.t({ id, message });
    const translated = () => {
        return {
            goToReply: translate("quote.goToReply", "Go to reply"),
            notOnScreen: translate("quote.notOnScreen", "The quoted reply is not on screen"),
        };
    };
    const german = {
        "quote.goToReply": "Zur Antwort",
        "quote.notOnScreen": "Die zitierte Antwort ist nicht auf dem Bildschirm",
    };

    afterEach(() => {
        editor?.destroy();
        editor = undefined;
        document.body.replaceChildren();
        vi.mocked(showWarning).mockClear();
    });

    const linkLabels = (instance: Editor): string[] =>
        [...instance.view.dom.querySelectorAll<HTMLButtonElement>(":scope [data-quote-chip] button")].map((button) => button.textContent ?? "");

    it("shows the new language on a chip added after the switch, without recreating the editor", () => {
        i18n.loadAndActivate({ locale: "en", messages: {} });
        editor = new Editor({ content: "", extensions: [StarterKit.configure({ blockquote: false }), QuoteChip.configure({ labels: translated })] });

        insertQuoteChip(editor, quoted);
        i18n.loadAndActivate({ locale: "de", messages: german });
        insertQuoteChip(editor, { messageId: "msg-9", text: "A later selection" });

        expect(linkLabels(editor)).toEqual(["Go to reply", "Zur Antwort"]);
    });

    it("warns in the new language when the chip's reply is not on screen", () => {
        i18n.loadAndActivate({ locale: "en", messages: {} });
        editor = new Editor({ content: "", extensions: [StarterKit.configure({ blockquote: false }), QuoteChip.configure({ labels: translated })] });

        i18n.loadAndActivate({ locale: "de", messages: german });
        insertQuoteChip(editor, { messageId: "msg-missing", text: "Gone" });
        editor.view.dom.querySelector<HTMLButtonElement>(":scope [data-quote-chip] button")?.click();

        expect(showWarning).toHaveBeenCalledWith("Die zitierte Antwort ist nicht auf dem Bildschirm");
    });

    it("repaints a chip drawn before the switch when the composer refreshes its labels", () => {
        i18n.loadAndActivate({ locale: "en", messages: {} });
        editor = new Editor({ content: "", extensions: [StarterKit.configure({ blockquote: false }), QuoteChip.configure({ labels: translated })] });
        insertQuoteChip(editor, quoted);

        i18n.loadAndActivate({ locale: "de", messages: german });

        expect(linkLabels(editor)).toEqual(["Go to reply"]);

        refreshQuoteChipLabels(editor.view.dom);

        expect(linkLabels(editor)).toEqual(["Zur Antwort"]);
    });
});
