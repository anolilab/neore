// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKitExtension from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import VimMode from "./extensions/vim-mode";
import { composerCoreExtensionOptions } from "./paste-plain-text";
import { WrapSelection, wrapSelection, wrapSelectionOnTextInput } from "./wrap-selection";

const editors: Editor[] = [];

const BACKSLASH = "\\";

const BACKTICK = "`";

const editorWith = (content: string): Editor => {
    const editor = new Editor({ content, coreExtensionOptions: composerCoreExtensionOptions, extensions: [StarterKitExtension] });

    editors.push(editor);

    return editor;
};

const select = (editor: Editor, from: number, to: number): void => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
};

const text = (editor: Editor): string => editor.getText({ blockSeparator: "\n" });

const selectedText = (editor: Editor): string => {
    const { from, to } = editor.state.selection;

    return editor.state.doc.textBetween(from, to);
};

describe("wrapSelectionOnTextInput", () => {
    afterEach(() => {
        for (const editor of editors) {
            editor.destroy();
        }

        editors.length = 0;
    });

    it.each([
        ["`", "`world`"],
        ["*", "**world**"],
        ["_", "_world_"],
    ])("wraps the selection in the delimiter typed %s", (typed, expected) => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 7, 12);

        expect(wrapSelectionOnTextInput(editor.view, 7, 12, typed)).toBe(true);
        expect(text(editor)).toBe(`hello ${expected}`);
    });

    it("keeps the wrapped text selected, so a second marker wraps it again", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 7, 12);
        wrapSelectionOnTextInput(editor.view, 7, 12, "*");

        expect(selectedText(editor)).toBe("world");

        const { from, to } = editor.state.selection;

        expect(wrapSelectionOnTextInput(editor.view, from, to, "_")).toBe(true);
        expect(text(editor)).toBe("hello **_world_**");
    });

    it("makes the wrap one step to undo", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 7, 12);
        wrapSelectionOnTextInput(editor.view, 7, 12, "`");
        editor.commands.undo();

        expect(text(editor)).toBe("hello world");
    });

    it("leaves typing alone when nothing is selected", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 12, 12);

        expect(wrapSelectionOnTextInput(editor.view, 12, 12, "*")).toBe(false);
        expect(text(editor)).toBe("hello world");
    });

    it("leaves a character that is no marker alone, even over a selection", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 7, 12);

        expect(wrapSelectionOnTextInput(editor.view, 7, 12, "a")).toBe(false);
    });

    it("leaves a selection across two blocks alone, so their break is not lost", () => {
        const editor = editorWith("<p>hello</p><p>world</p>");

        expect(wrapSelectionOnTextInput(editor.view, 3, 10, "*")).toBe(false);
        expect(text(editor)).toBe("hello\nworld");
    });

    it("leaves a selection that holds a line break alone", () => {
        const editor = editorWith("<p>ab<br>cd</p>");

        expect(wrapSelectionOnTextInput(editor.view, 2, 5, "_")).toBe(false);
    });

    it("leaves composition text alone, so an IME commit still replaces the selection", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 7, 12);
        Object.defineProperty(editor.view, "composing", { configurable: true, get: () => true });

        expect(wrapSelectionOnTextInput(editor.view, 7, 12, "*")).toBe(false);
    });
});

describe("WrapSelection with vim mode", () => {
    afterEach(() => {
        for (const editor of editors) {
            editor.destroy();
        }

        editors.length = 0;
    });

    // The order the composer registers them in: vim first, so its normal mode takes typed text before a wrap can.
    const vimEditorWith = (content: string): Editor => {
        const editor = new Editor({
            content,
            coreExtensionOptions: composerCoreExtensionOptions,
            extensions: [
                StarterKitExtension,
                VimMode.configure({ isEnabled: () => true, isHistoryRecalled: () => false, onModeChange: () => {} }),
                WrapSelection,
            ],
        });

        editors.push(editor);

        return editor;
    };

    /** Asks the view's text-input handlers in order, as ProseMirror does for typed text. */
    const typeOver = (editor: Editor, from: number, to: number, typed: string): boolean =>
        Boolean(editor.view.someProp("handleTextInput", (handle) => handle(editor.view, from, to, typed, () => editor.state.tr)));

    const pressKey = (editor: Editor, key: string): void => {
        editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, new KeyboardEvent("keydown", { key })));
    };

    it("wraps the selection in insert mode, where vim takes no text", () => {
        const editor = vimEditorWith("<p>hello world</p>");

        select(editor, 7, 12);

        expect(typeOver(editor, 7, 12, "*")).toBe(true);
        expect(text(editor)).toBe("hello **world**");
    });

    it("leaves the selection alone in vim normal mode, which takes typed text", () => {
        const editor = vimEditorWith("<p>hello world</p>");

        select(editor, 7, 12);
        pressKey(editor, "Escape");

        expect(typeOver(editor, 7, 12, "*")).toBe(true);
        expect(text(editor)).toBe("hello world");
    });
});

describe("wrapSelection edge cases", () => {
    afterEach(() => {
        for (const editor of editors) {
            editor.destroy();
        }

        editors.length = 0;
    });

    it("leaves a select-all over several paragraphs alone, so their breaks are kept", () => {
        const editor = editorWith("<p>hello</p><p>world</p>");

        expect(wrapSelectionOnTextInput(editor.view, 0, editor.state.doc.content.size, "*")).toBe(false);
        expect(text(editor)).toBe("hello\nworld");
    });

    it("leaves a select-all of one paragraph alone, as it replaces the whole draft", () => {
        const editor = editorWith("<p>hello world</p>");

        expect(wrapSelectionOnTextInput(editor.view, 0, editor.state.doc.content.size, "*")).toBe(false);
        expect(text(editor)).toBe("hello world");
    });

    it("keeps the spaces at the edges of the selection outside the bold, so Markdown still renders it", () => {
        const editor = editorWith("<p>hello world and</p>");

        select(editor, 7, 13);
        wrapSelectionOnTextInput(editor.view, 7, 13, "*");

        expect(text(editor)).toBe("hello **world** and");
        expect(selectedText(editor)).toBe("world");
    });

    it("keeps leading spaces outside the delimiters too", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 6, 12);
        wrapSelectionOnTextInput(editor.view, 6, 12, "_");

        expect(text(editor)).toBe("hello _world_");
    });

    it("leaves a selection of only spaces alone", () => {
        const editor = editorWith("<p>hello world</p>");

        select(editor, 6, 7);

        expect(wrapSelectionOnTextInput(editor.view, 6, 7, "*")).toBe(false);
        expect(text(editor)).toBe("hello world");
    });

    it("uses a longer backtick fence when the selected code already has backticks", () => {
        const editor = editorWith("<p>x a`b y</p>");

        select(editor, 3, 6);
        wrapSelectionOnTextInput(editor.view, 3, 6, "`");

        expect(text(editor)).toBe("x ``a`b`` y");
    });

    it("pads the code span with a space when the selected code starts with a backtick", () => {
        const editor = editorWith("<p>x `ab y</p>");

        select(editor, 3, 6);
        wrapSelectionOnTextInput(editor.view, 3, 6, "`");

        expect(text(editor)).toBe("x `` `ab `` y");
    });

    it("uses asterisks for italic inside a word, where an underscore would not render", () => {
        const editor = editorWith("<p>foobarbaz</p>");

        select(editor, 4, 7);
        wrapSelectionOnTextInput(editor.view, 4, 7, "_");

        expect(text(editor)).toBe("foo*bar*baz");
    });

    it("keeps the underscore for italic at a word's edge", () => {
        const editor = editorWith("<p>foo bar baz</p>");

        select(editor, 5, 8);
        wrapSelectionOnTextInput(editor.view, 5, 8, "_");

        expect(text(editor)).toBe("foo _bar_ baz");
    });

    it("escapes a copy of the delimiter inside the bold text, so it stays text", () => {
        const editor = editorWith("<p>a * b</p>");

        select(editor, 3, 4);
        wrapSelectionOnTextInput(editor.view, 3, 4, "*");

        expect(text(editor)).toBe(String.raw`a **\*** b`);
        expect(selectedText(editor)).toBe(String.raw`\*`);
    });

    it("escapes an underscore inside the italic text, and keeps the selection over the escaped text", () => {
        const editor = editorWith("<p>x a_b y</p>");

        select(editor, 3, 6);
        wrapSelectionOnTextInput(editor.view, 3, 6, "_");

        expect(text(editor)).toBe(String.raw`x _a\_b_ y`);
        expect(selectedText(editor)).toBe(String.raw`a\_b`);
    });

    it("wraps a selection with very many backtick runs in code", () => {
        const runs = "`a".repeat(4900);
        const editor = editorWith(`<p>x ${runs} y</p>`);
        const end = 3 + runs.length;

        expect(wrapSelectionOnTextInput(editor.view, 3, end, "`")).toBe(true);
        expect(text(editor).startsWith("x `` `a")).toBe(true);
    });

    it("keeps a backward selection backward after the wrap", () => {
        const editor = editorWith("<p>hello world</p>");

        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 12, 7)));
        wrapSelectionOnTextInput(editor.view, 7, 12, "*");

        expect(editor.state.selection.anchor).toBe(14);
        expect(editor.state.selection.head).toBe(9);
        expect(selectedText(editor)).toBe("world");
    });
});

describe("wrapSelection", () => {
    afterEach(() => {
        for (const editor of editors) {
            editor.destroy();
        }

        editors.length = 0;
    });

    it("returns no transaction for a marker over an empty selection", () => {
        const editor = editorWith("<p>hello</p>");

        expect(wrapSelection(editor.state, 3, 3, "`")).toBeNull();
    });

    it("returns a transaction that selects only the wrapped text", () => {
        const editor = editorWith("<p>hello world</p>");
        const transaction = wrapSelection(editor.state, 1, 6, "_");

        if (transaction === null) {
            throw new Error("expected a transaction");
        }

        editor.view.dispatch(transaction);

        expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe("hello");
        expect(text(editor)).toBe("_hello_ world");
    });
});

describe("wrapSelectionOnTextInput Markdown edge cases", () => {
    afterEach(() => {
        for (const editor of editors) {
            editor.destroy();
        }

        editors.length = 0;
    });

    it("leaves a code wrap alone beside a backtick, which would join its fence", () => {
        const editor = editorWith("<p>foo`</p>");

        select(editor, 1, 4);

        expect(wrapSelectionOnTextInput(editor.view, 1, 4, "`")).toBe(true);
        expect(text(editor)).toBe("foo`");
    });

    it("uses a single asterisk for italic beside an astral letter, which counts as a word character", () => {
        const editor = editorWith("<p>𝔸foo</p>");

        select(editor, 3, 6);
        wrapSelectionOnTextInput(editor.view, 3, 6, "_");

        expect(text(editor)).toBe("𝔸*foo*");
    });

    it("doubles a trailing backslash so it does not escape the closing delimiter", () => {
        const editor = editorWith(String.raw`<p>foo\ bar</p>`);

        select(editor, 1, 5);
        wrapSelectionOnTextInput(editor.view, 1, 5, "*");

        expect(text(editor)).toBe(String.raw`**foo\\** bar`);
    });

    it("keeps a backslash that already escapes a star, instead of escaping it again", () => {
        const editor = editorWith(String.raw`<p>a\*b c</p>`);

        select(editor, 1, 5);
        wrapSelectionOnTextInput(editor.view, 1, 5, "*");

        expect(text(editor)).toBe(String.raw`**a\*b** c`);
    });

    it("leaves a wrap alone when a backslash before the opener would escape it", () => {
        const editor = editorWith(String.raw`<p>a\foo</p>`);

        select(editor, 3, 6);

        expect(wrapSelectionOnTextInput(editor.view, 3, 6, "*")).toBe(true);
        expect(text(editor)).toBe(String.raw`a\foo`);
    });

    it("leaves a selected period after a letter alone, as its asterisks would not open or close", () => {
        const editor = editorWith("<p>a.b</p>");

        select(editor, 2, 3);

        expect(wrapSelectionOnTextInput(editor.view, 2, 3, "*")).toBe(true);
        expect(text(editor)).toBe("a.b");
    });

    it("leaves an italic wrap alone when an underscore is already beside the selection, so the runs would merge", () => {
        const editor = editorWith("<p>foo_bar</p>");

        select(editor, 5, 8);

        expect(wrapSelectionOnTextInput(editor.view, 5, 8, "_")).toBe(true);
        expect(text(editor)).toBe("foo_bar");
    });

    it("leaves a bold wrap alone when an asterisk is already before the selection, so the runs would merge", () => {
        const editor = editorWith("<p>a**foo</p>");

        select(editor, 4, 7);

        expect(wrapSelectionOnTextInput(editor.view, 4, 7, "*")).toBe(true);
        expect(text(editor)).toBe("a**foo");
    });

    it("leaves a wrap alone inside an inline code span, where the delimiters would show literally", () => {
        const editor = editorWith("<p>x `foo` y</p>");

        select(editor, 4, 7);

        expect(wrapSelectionOnTextInput(editor.view, 4, 7, "*")).toBe(true);
        expect(text(editor)).toBe("x `foo` y");
    });

    it("finds a code span opened right after a line break, which a backslash before the break does not escape", () => {
        // a, backslash, line break, then `foo` with "foo" at positions 5 to 8.
        const editor = editorWith("<p>a&#92;<br>`foo` b</p>");
        const before = text(editor);

        select(editor, 5, 8);

        expect(wrapSelectionOnTextInput(editor.view, 5, 8, "*")).toBe(true);
        expect(text(editor)).toBe(before);
    });

    it("wraps quickly beside many unmatched backtick runs of different lengths", () => {
        const runs = Array.from({ length: 130 }, (_, index) => `${"`".repeat(index + 1)}x`).join("");
        const editor = editorWith(`<p>hello ${runs}</p>`);

        select(editor, 1, 6);

        expect(wrapSelectionOnTextInput(editor.view, 1, 6, "*")).toBe(true);
        expect(text(editor).startsWith("**hello** `x")).toBe(true);
    });

    it("leaves a wrap alone inside a link destination, so the link keeps pointing where it did", () => {
        const editor = editorWith("<p>see [docs](https://example.com) now</p>");

        select(editor, 20, 27);

        expect(selectedText(editor)).toBe("example");
        expect(wrapSelectionOnTextInput(editor.view, 20, 27, "*")).toBe(true);
        expect(text(editor)).toBe("see [docs](https://example.com) now");
    });

    it("protects a link destination past balanced parentheses", () => {
        const editor = editorWith("<p>see [x](foo(bar)baz) now</p>");

        select(editor, 17, 20);

        expect(selectedText(editor)).toBe("baz");
        expect(wrapSelectionOnTextInput(editor.view, 17, 20, "*")).toBe(true);
        expect(text(editor)).toBe("see [x](foo(bar)baz) now");
    });

    it("protects a link destination past an escaped parenthesis", () => {
        const editor = editorWith("<p>[d](a&#92;)bc) x</p>");
        const before = text(editor);

        select(editor, 8, 10);

        expect(selectedText(editor)).toBe("bc");
        expect(wrapSelectionOnTextInput(editor.view, 8, 10, "*")).toBe(true);
        expect(text(editor)).toBe(before);
    });

    it("protects an angle-bracket destination past a parenthesis inside it", () => {
        const editor = editorWith("<p>see [x](&lt;foo)bar&gt;) now</p>");
        const before = text(editor);

        select(editor, 14, 17);

        expect(selectedText(editor)).toBe("bar");
        expect(wrapSelectionOnTextInput(editor.view, 14, 17, "*")).toBe(true);
        expect(text(editor)).toBe(before);
    });

    it("leaves a link label alone when the selection holds its brackets, which would split it from its URL", () => {
        const editor = editorWith("<p>see [docs](https://example.com) now</p>");

        select(editor, 5, 11);

        expect(selectedText(editor)).toBe("[docs]");
        expect(wrapSelectionOnTextInput(editor.view, 5, 11, "*")).toBe(true);
        expect(text(editor)).toBe("see [docs](https://example.com) now");
    });

    it("wraps a selection that holds a whole link", () => {
        const editor = editorWith("<p>see [docs](https://example.com) now</p>");

        select(editor, 5, 32);
        wrapSelectionOnTextInput(editor.view, 5, 32, "*");

        expect(text(editor)).toBe("see **[docs](https://example.com)** now");
    });

    it("leaves a wrap alone inside an autolink, whose syntax it would break", () => {
        const editor = editorWith("<p>go &lt;https://example.com&gt; now</p>");
        const before = text(editor);

        select(editor, 5, 10);

        expect(selectedText(editor)).toBe("https");
        expect(wrapSelectionOnTextInput(editor.view, 5, 10, "*")).toBe(true);
        expect(text(editor)).toBe(before);
    });

    it("wraps quickly beside many unclosed link destinations", () => {
        const editor = editorWith(`<p>hello ${"[x](".repeat(2400)}</p>`);

        select(editor, 1, 6);

        expect(wrapSelectionOnTextInput(editor.view, 1, 6, "*")).toBe(true);
        expect(text(editor).startsWith("**hello** [x](")).toBe(true);
    });

    it("leaves typing alone in a draft longer than the size cap", () => {
        const editor = editorWith(`<p>hello ${"a".repeat(10_000)}</p>`);

        select(editor, 1, 6);

        expect(wrapSelectionOnTextInput(editor.view, 1, 6, "*")).toBe(false);
    });

    it("wraps text inside an escaped autolink, which is literal text", () => {
        const editor = editorWith("<p>go &#92;&lt;https://example.com&gt; now</p>");

        select(editor, 6, 11);

        expect(selectedText(editor)).toBe("https");
        expect(wrapSelectionOnTextInput(editor.view, 6, 11, "*")).toBe(true);
        expect(text(editor)).toBe(String.raw`go \<**https**://example.com> now`);
    });

    it("leaves an image's ! alone, which would turn the image into a link", () => {
        const editor = editorWith("<p>see ![a](b.png) now</p>");

        select(editor, 5, 6);

        expect(wrapSelectionOnTextInput(editor.view, 5, 6, "*")).toBe(true);
        expect(text(editor)).toBe("see ![a](b.png) now");
    });

    it("leaves a reference link's second label alone, which would split the link", () => {
        const editor = editorWith("<p>[docs][ref] x</p><p></p><p>[ref]: https://e.com</p>");
        const before = text(editor);

        select(editor, 7, 12);

        expect(selectedText(editor)).toBe("[ref]");
        expect(wrapSelectionOnTextInput(editor.view, 7, 12, "*")).toBe(true);
        expect(text(editor)).toBe(before);
    });

    it("protects a link title that holds a parenthesis", () => {
        const editor = editorWith('<p>[x](url "a)" ) y</p>');

        select(editor, 12, 13);

        expect(wrapSelectionOnTextInput(editor.view, 12, 13, "*")).toBe(true);
        expect(text(editor)).toBe('[x](url "a)" ) y');
    });

    it("wraps quickly beside many autolinks and code spans", () => {
        const editor = editorWith(`<p>hello ${"&lt;a@b.c&gt; `c` ".repeat(800)}</p>`);

        select(editor, 1, 6);

        expect(wrapSelectionOnTextInput(editor.view, 1, 6, "*")).toBe(true);
        expect(text(editor).startsWith("**hello** <a@b.c>")).toBe(true);
    });

    it("reads a line break before the selection as a line end, not as the text before it", () => {
        const editor = editorWith("<p>a*<br>foo</p>");

        select(editor, 4, 7);

        expect(selectedText(editor)).toBe("foo");
        expect(wrapSelectionOnTextInput(editor.view, 4, 7, "*")).toBe(true);
        expect(text(editor)).toContain("**foo**");
    });

    it("wraps link-like prose whose destination has a space, which is no link", () => {
        const editor = editorWith("<p>[a](b c) d</p>");

        select(editor, 7, 8);
        wrapSelectionOnTextInput(editor.view, 7, 8, "*");

        expect(text(editor)).toBe("[a](b **c**) d");
    });

    it("avoids the fence length of a backtick after two backslashes, which is not escaped", () => {
        const editor = editorWith("<p>a &#92;&#92;`b foo</p>");

        select(editor, 8, 11);
        wrapSelectionOnTextInput(editor.view, 8, 11, "`");

        expect(text(editor)).toBe(`a ${BACKSLASH}${BACKSLASH}${BACKTICK}b ${BACKTICK.repeat(2)}foo${BACKTICK.repeat(2)}`);
    });

    it("keeps a backslash before a closing backtick inside the code span, as CommonMark does", () => {
        const editor = editorWith("<p>x `a*&#92;` y</p>");

        select(editor, 3, 8);
        wrapSelectionOnTextInput(editor.view, 3, 8, "*");

        expect(text(editor)).toBe(`x **${BACKTICK}a*${BACKSLASH}${BACKTICK}** y`);
    });

    it("leaves a shortcut reference's text alone, which is its identifier", () => {
        const editor = editorWith("<p>see [docs] now</p><p></p><p>[docs]: https://example.com</p>");
        const before = text(editor);

        select(editor, 6, 10);

        expect(selectedText(editor)).toBe("docs");
        expect(wrapSelectionOnTextInput(editor.view, 6, 10, "*")).toBe(true);
        expect(text(editor)).toBe(before);
    });

    it("leaves a whole reference definition alone, which wrapping would unlink", () => {
        const editor = editorWith("<p>[docs] x</p><p></p><p>[docs]: https://example.com</p>");
        const before = text(editor);

        select(editor, 13, 40);

        expect(selectedText(editor)).toBe("[docs]: https://example.com");
        expect(wrapSelectionOnTextInput(editor.view, 13, 40, "*")).toBe(true);
        expect(text(editor)).toBe(before);
    });

    it("wraps beside an escaped star, which does not join the new delimiter run", () => {
        const editor = editorWith("<p>a&#92;*foo b</p>");

        select(editor, 4, 7);
        wrapSelectionOnTextInput(editor.view, 4, 7, "*");

        expect(text(editor)).toBe(String.raw`a\***foo** b`);
    });

    it("leaves a blockquote line alone when the selection holds its > marker", () => {
        const editor = editorWith("<p>&gt; foo</p>");

        select(editor, 1, 6);

        expect(wrapSelectionOnTextInput(editor.view, 1, 6, "*")).toBe(true);
        expect(text(editor)).toBe("> foo");
    });

    it("leaves a list item alone when the selection holds its bullet", () => {
        const editor = editorWith("<p>- item</p>");

        select(editor, 1, 7);

        expect(wrapSelectionOnTextInput(editor.view, 1, 7, "*")).toBe(true);
        expect(text(editor)).toBe("- item");
    });

    it("wraps the text after a blockquote marker", () => {
        const editor = editorWith("<p>&gt; foo</p>");

        select(editor, 3, 6);
        wrapSelectionOnTextInput(editor.view, 3, 6, "*");

        expect(text(editor)).toBe("> **foo**");
    });

    it("wraps quickly after thousands of nested quote markers", () => {
        const quotes = "&gt;".repeat(9000);
        const editor = editorWith(`<p>${quotes} foo</p>`);

        select(editor, 9002, 9005);

        expect(selectedText(editor)).toBe("foo");
        expect(wrapSelectionOnTextInput(editor.view, 9002, 9005, "*")).toBe(true);
        expect(text(editor).endsWith("> **foo**")).toBe(true);
    });

    it("leaves a heading after a line break alone when the selection holds its #", () => {
        const editor = editorWith("<p>a<br># heading</p>");
        const before = text(editor);

        select(editor, 3, 12);

        expect(selectedText(editor)).toBe("# heading");
        expect(wrapSelectionOnTextInput(editor.view, 3, 12, "*")).toBe(true);
        expect(text(editor)).toBe(before);
    });

    it("wraps a heading's text after a line break", () => {
        const editor = editorWith("<p>a<br># heading</p>");

        select(editor, 5, 12);
        wrapSelectionOnTextInput(editor.view, 5, 12, "*");

        expect(selectedText(editor)).toBe("heading");
        expect(text(editor)).toContain("# **heading**");
    });

    it("leaves a whole code fence line alone, which wrapping would end", () => {
        const editor = editorWith("<p>```foo</p>");

        select(editor, 1, 7);

        expect(wrapSelectionOnTextInput(editor.view, 1, 7, "*")).toBe(true);
        expect(text(editor)).toBe("```foo");
    });

    it("leaves a divider alone, which a wrap would turn into text", () => {
        const editor = editorWith("<p>a</p><p></p><p>---</p>");

        select(editor, 6, 9);

        expect(selectedText(editor)).toBe("---");
        expect(wrapSelectionOnTextInput(editor.view, 6, 9, "`")).toBe(true);
        expect(text(editor)).toBe("a\n\n---");
    });

    it("leaves a setext heading's underline alone, and still wraps its text", () => {
        const editor = editorWith("<p>Title</p><p>===</p>");

        select(editor, 8, 11);

        expect(selectedText(editor)).toBe("===");
        expect(wrapSelectionOnTextInput(editor.view, 8, 11, "*")).toBe(true);
        expect(text(editor)).toBe("Title\n===");

        select(editor, 1, 6);
        wrapSelectionOnTextInput(editor.view, 1, 6, "*");

        expect(text(editor)).toBe("**Title**\n===");
    });

    it("leaves a table's separator row and cell pipes alone, and still wraps a cell's text", () => {
        const editor = editorWith("<p>| a | b |</p><p>| --- | --- |</p><p>| c | d |</p>");
        const before = text(editor);

        select(editor, 14, 17);

        expect(selectedText(editor)).toBe("---");
        expect(wrapSelectionOnTextInput(editor.view, 14, 17, "*")).toBe(true);
        expect(text(editor)).toBe(before);

        select(editor, 29, 34);

        expect(selectedText(editor)).toBe("c | d");
        expect(wrapSelectionOnTextInput(editor.view, 29, 34, "*")).toBe(true);
        expect(text(editor)).toBe(before);

        select(editor, 29, 30);
        wrapSelectionOnTextInput(editor.view, 29, 30, "*");

        expect(text(editor)).toBe("| a | b |\n| --- | --- |\n| **c** | d |");
    });

    it("wraps literal ](url) text that has no link label before it", () => {
        const editor = editorWith("<p>literal ](url) text</p>");

        select(editor, 11, 14);
        wrapSelectionOnTextInput(editor.view, 11, 14, "*");

        expect(text(editor)).toBe("literal ](**url**) text");
    });

    it("still wraps a link's label", () => {
        const editor = editorWith("<p>see [docs](https://example.com) now</p>");

        select(editor, 6, 10);
        wrapSelectionOnTextInput(editor.view, 6, 10, "*");

        expect(text(editor)).toBe("see [**docs**](https://example.com) now");
    });

    it("wraps a whole code span that holds link syntax, which is literal there", () => {
        const editor = editorWith("<p>x `[foo](https://e.com)` y</p>");

        select(editor, 3, 25);
        wrapSelectionOnTextInput(editor.view, 3, 25, "*");

        expect(text(editor)).toBe("x **`[foo](https://e.com)`** y");
    });

    it("uses a fence length that an earlier unmatched backtick cannot pair with", () => {
        const editor = editorWith("<p>`a foo bar</p>");

        select(editor, 4, 7);
        wrapSelectionOnTextInput(editor.view, 4, 7, "`");

        expect(text(editor)).toBe("`a ``foo`` bar");
        expect(selectedText(editor)).toBe("foo");
    });

    it("leaves a star inside a selected code span unescaped, where a backslash would show", () => {
        const editor = editorWith("<p>x `a*b` y</p>");

        select(editor, 3, 8);
        wrapSelectionOnTextInput(editor.view, 3, 8, "*");

        expect(text(editor)).toBe("x **`a*b`** y");
    });

    it("wraps a selection that holds a whole inline code span, since both of its ends are outside the span", () => {
        const editor = editorWith("<p>x `foo` y</p>");

        select(editor, 3, 8);

        expect(wrapSelectionOnTextInput(editor.view, 3, 8, "*")).toBe(true);
        expect(text(editor)).toBe("x **`foo`** y");
    });
});
