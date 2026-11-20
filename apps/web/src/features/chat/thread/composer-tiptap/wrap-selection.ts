import { Extension } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

type Marker = "`" | "*" | "_";

const MARKERS: ReadonlySet<string> = new Set(["*", "_", "`"]);

/** A letter, digit or combining mark: what makes the text beside a wrap part of a word. */
const WORD_CHARACTER = /[\p{L}\p{M}\p{N}]/u;

const PUNCTUATION = /[\p{P}\p{S}]/u;

const WHITESPACE = /\s/u;

const isMarker = (typed: string): typed is Marker => MARKERS.has(typed);

/** The last whole character of `text`, so an astral letter is one character, not two halves. */
const lastCharacter = (text: string): string => [...text.slice(-2)].at(-1) ?? "";

/** The first whole character of `text`. */
const firstCharacter = (text: string): string => [...text.slice(0, 2)][0] ?? "";

const isSpace = (character: string): boolean => character === "" || WHITESPACE.test(character);

const trailingBackslashes = (text: string): number => {
    let count = 0;

    while (count < text.length && text[text.length - 1 - count] === "\\") {
        count += 1;
    }

    return count;
};

/** A copy of `character` in the text is escaped, unless an odd run of backslashes before it already escapes it. */
const escapeCharacter = (text: string, character: string): string => {
    let escaped = "";
    let backslashes = 0;

    for (const current of text) {
        if (current === character && backslashes % 2 === 0) {
            escaped += "\\";
        }

        escaped += current;
        backslashes = current === "\\" ? backslashes + 1 : 0;
    }

    // An odd run at the end would escape the closing delimiter, so it is doubled: the text renders the same.
    return backslashes % 2 === 1 ? `${escaped}\\` : escaped;
};

/**
 * Whether the delimiters open and close emphasis around `body`, by the CommonMark flanking rules. A delimiter that does
 * not flank would be shown as typed, so such a selection is not wrapped. Underscores have the stricter rules too.
 */
const delimitersWork = (wrap: { closeAfter: string; closeBefore: string; openAfter: string; openBefore: string; underscore: boolean }): boolean => {
    const flanks = (before: string, after: string): { left: boolean; right: boolean } => {
        const left = !isSpace(after) && (!PUNCTUATION.test(after) || isSpace(before) || PUNCTUATION.test(before));
        const right = !isSpace(before) && (!PUNCTUATION.test(before) || isSpace(after) || PUNCTUATION.test(after));

        return { left, right };
    };
    const opening = flanks(wrap.openBefore, wrap.openAfter);
    const closing = flanks(wrap.closeBefore, wrap.closeAfter);

    return (
        opening.left &&
        (!wrap.underscore || !opening.right || PUNCTUATION.test(wrap.openBefore)) &&
        closing.right &&
        (!wrap.underscore || !closing.left || PUNCTUATION.test(wrap.closeAfter))
    );
};

/** The text a wrap puts around the selected body: the opening and closing delimiters, and the body as Markdown. */
interface Wrap {
    body: string;
    close: string;
    open: string;
}

/**
 * The wrap a marker makes of `body`. The composer sends its text as Markdown and its bold, italic and code marks are off,
 * so the delimiters are the formatting. `insideWord` is whether the selection touches a letter or digit on either side.
 */
const wrapFor = (marker: Marker, body: string, insideWord: boolean): Wrap => {
    if (marker === "`") {
        // A fence longer than any backtick run in the code keeps it one code span; a space pads a backtick at an edge.
        let longestRun = 0;

        for (const run of body.matchAll(/`+/g)) {
            longestRun = Math.max(longestRun, run[0].length);
        }

        const fence = "`".repeat(longestRun + 1);
        const pad = body.startsWith("`") || body.endsWith("`") ? " " : "";

        return { body, close: `${pad}${fence}`, open: `${fence}${pad}` };
    }

    // Markdown opens and closes an underscore emphasis only at a word's edge, so inside a word an asterisk does the job.
    const character = marker === "_" && !insideWord ? "_" : "*";
    const delimiter = marker === "*" ? "**" : character;

    // A copy of the delimiter character inside the text would end the emphasis early, so it is escaped.
    return { body: escapeCharacter(body, character), close: delimiter, open: delimiter };
};

/**
 * The transaction that wraps the selection `from`..`to` in the delimiters `typed` stands for, leaving the wrapped text
 * selected in the same direction. Whitespace at the edges stays outside the delimiters, where Markdown can use it.
 *
 * Returns `null` when the typed text is no marker, nothing is selected, the selection is not inside one textblock (a
 * select-all or a range over several paragraphs), it holds a node other than text (a quote chip, a line break), or it
 * is only whitespace. It also returns `null` when the wrap would not render: a backtick beside a code wrap, a backslash
 * before the opening delimiter, or delimiters that do not open or close beside the text. Typing then replaces the
 * selection as it always did.
 */
export const wrapSelection = (state: EditorState, from: number, to: number, typed: string): Transaction | null => {
    if (from === to || !isMarker(typed)) {
        return null;
    }

    const $from = state.doc.resolve(from);
    const $to = state.doc.resolve(to);

    if (!$from.sameParent($to) || !$from.parent.isTextblock) {
        return null;
    }

    let onlyText = true;

    state.doc.nodesBetween(from, to, (node) => {
        if (node.isLeaf && !node.isText) {
            onlyText = false;
        }
    });

    if (!onlyText) {
        return null;
    }

    const selected = state.doc.textBetween(from, to);
    const body = selected.trim();

    if (body === "") {
        return null;
    }

    const lead = selected.indexOf(body);
    const trail = selected.slice(lead + body.length);
    const { parent } = $from;
    const beforeOpen = `${parent.textBetween(0, $from.parentOffset)}${selected.slice(0, lead)}`;
    const afterClose = `${trail}${parent.textBetween($to.parentOffset, parent.content.size)}`;
    const openBefore = lastCharacter(beforeOpen);
    const closeAfter = firstCharacter(afterClose);
    // Only a letter, digit or mark that touches the wrapped text itself makes it a word; the spaces around it do not.
    const insideWord = (lead === 0 && WORD_CHARACTER.test(openBefore)) || (trail.length === 0 && WORD_CHARACTER.test(closeAfter));

    // An odd run of backslashes before the opener would escape it, and a backtick beside a code fence would join it.
    if (trailingBackslashes(beforeOpen) % 2 === 1 || (typed === "`" && (openBefore === "`" || closeAfter === "`"))) {
        return null;
    }

    const wrap = wrapFor(typed, body, insideWord);
    const underscore = typed === "_" && !insideWord;

    if (typed !== "`" && !delimitersWork({ closeAfter, closeBefore: lastCharacter(body), openAfter: firstCharacter(body), openBefore, underscore })) {
        return null;
    }

    const transaction = state.tr.insertText(`${selected.slice(0, lead)}${wrap.open}${wrap.body}${wrap.close}${trail}`, from, to);
    const innerStart = from + lead + wrap.open.length;
    const innerEnd = innerStart + wrap.body.length;
    const backward = state.selection.anchor === to && state.selection.head === from;

    return transaction.setSelection(
        backward ? TextSelection.create(transaction.doc, innerEnd, innerStart) : TextSelection.create(transaction.doc, innerStart, innerEnd),
    );
};

/**
 * A marker typed over a selection wraps it. Composition text is left alone, so an IME commit replaces the selection as
 * it does today.
 */
export const wrapSelectionOnTextInput = (view: EditorView, from: number, to: number, typed: string): boolean => {
    if (view.composing) {
        return false;
    }

    const transaction = wrapSelection(view.state, from, to, typed);

    if (transaction === null) {
        return false;
    }

    view.dispatch(transaction);

    return true;
};

/**
 * Registers `wrapSelectionOnTextInput` as a plugin. It must come after `VimMode` in the editor's extensions: ProseMirror
 * asks plugins in order, and vim's normal mode takes typed text, so a selection there must not be wrapped. Editor props
 * are asked before any plugin, which is why this is not an `editorProps` handler.
 */
export const WrapSelection = Extension.create({
    addProseMirrorPlugins() {
        return [new Plugin({ props: { handleTextInput: wrapSelectionOnTextInput } })];
    },

    name: "wrapSelection",
});
