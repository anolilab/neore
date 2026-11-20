import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
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

const runLength = (text: string, start: number): number => {
    let end = start;

    while (end < text.length && text[end] === "`") {
        end += 1;
    }

    return end - start;
};

/**
 * A lookup of the next backtick run of an exact length at or after a position. The runs are found in one pass and each
 * length keeps a cursor that only moves forward, because the scan in `codeSpans` asks with rising positions: the whole
 * paragraph is read a bounded number of times, however many runs it has.
 */
const nextRunFinder = (text: string): ((start: number, length: number) => number) => {
    const runsByLength = new Map<number, number[]>();

    for (const run of text.matchAll(/`+/g)) {
        const starts = runsByLength.get(run[0].length) ?? [];

        starts.push(run.index);
        runsByLength.set(run[0].length, starts);
    }

    const cursors = new Map<number, number>();

    return (start, length) => {
        const starts = runsByLength.get(length) ?? [];
        let cursor = cursors.get(length) ?? 0;

        while (cursor < starts.length && (starts[cursor] ?? 0) < start) {
            cursor += 1;
        }

        cursors.set(length, cursor);

        return starts[cursor] ?? -1;
    };
};

/**
 * The inline code spans of a paragraph, as parent offsets. Markdown shows everything inside one literally, so a delimiter
 * inserted there would not render. A backtick escaped by a backslash outside code does not open a span. A line break or
 * other inline node counts as a line ending, so a backslash before it escapes nothing after it.
 */
const codeSpans = (parent: ProseMirrorNode): [number, number][] => {
    const offsets: number[] = [];
    let text = "";

    parent.forEach((child, offset) => {
        const part = child.isText ? (child.text ?? "") : "\n";

        for (let index = 0; index < part.length; index += 1) {
            offsets.push(offset + index);
        }

        text += part;
    });

    const findRun = nextRunFinder(text);
    const spans: [number, number][] = [];
    let index = 0;

    while (index < text.length) {
        if (text[index] === "\\") {
            index += 2;
        } else if (text[index] === "`") {
            const length = runLength(text, index);
            const closing = findRun(index + length, length);

            if (closing === -1) {
                index += length;
            } else {
                // Every index of `text` has an offset, so both lookups exist; `?? 0` only narrows the type.
                spans.push([offsets[index] ?? 0, (offsets[closing + length - 1] ?? 0) + 1]);
                index = closing + length;
            }
        } else {
            index += 1;
        }
    }

    return spans;
};

/**
 * Whether either end of the selection is strictly inside an inline code span: a delimiter inserted there would show as
 * literal text. A selection that only holds a whole span is fine, because both of its ends are outside it.
 */
const insideCodeSpan = (parent: ProseMirrorNode, from: number, to: number): boolean =>
    codeSpans(parent).some(([start, end]) => (from > start && from < end) || (to > start && to < end));

const trailingBackslashes = (text: string): number => {
    let count = 0;

    while (count < text.length && text[text.length - 1 - count] === "\\") {
        count += 1;
    }

    return count;
};

/** Whether an odd run of backslashes before the opener would escape it, or a backtick beside a code wrap would join its fence. */
const collidesWithMarkup = (beforeOpen: string, typed: string, openBefore: string, closeAfter: string): boolean =>
    trailingBackslashes(beforeOpen) % 2 === 1 || (typed === "`" && (openBefore === "`" || closeAfter === "`"));

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
 * before the opening delimiter, or delimiters that do not open or close beside the text.
 * The marker is then dropped and the selection stays, so the selected text is never replaced.
 */
const REFUSED = "refused";

type Plan = Transaction | typeof REFUSED | null;

/** The transaction for a wrap, `REFUSED` when the Markdown would not render it, or `null` when the typed text is no wrap. */
const planWrap = (state: EditorState, from: number, to: number, typed: string): Plan => {
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
    if (collidesWithMarkup(beforeOpen, typed, openBefore, closeAfter)) {
        return REFUSED;
    }

    if (insideCodeSpan(parent, $from.parentOffset, $to.parentOffset)) {
        return REFUSED;
    }

    const wrap = wrapFor(typed, body, insideWord);
    const underscore = typed === "_" && !insideWord;

    // A copy of the delimiter character right beside the wrap joins its run, and CommonMark then pairs the wrong runs.
    const delimiter = wrap.open.charAt(0);

    if (typed !== "`" && (openBefore === delimiter || closeAfter === delimiter)) {
        return REFUSED;
    }

    if (typed !== "`" && !delimitersWork({ closeAfter, closeBefore: lastCharacter(body), openAfter: firstCharacter(body), openBefore, underscore })) {
        return REFUSED;
    }

    const transaction = state.tr.insertText(`${selected.slice(0, lead)}${wrap.open}${wrap.body}${wrap.close}${trail}`, from, to);
    const innerStart = from + lead + wrap.open.length;
    const innerEnd = innerStart + wrap.body.length;
    const backward = state.selection.anchor === to && state.selection.head === from;

    return transaction.setSelection(
        backward ? TextSelection.create(transaction.doc, innerEnd, innerStart) : TextSelection.create(transaction.doc, innerStart, innerEnd),
    );
};

/** The transaction that wraps the selection, or `null` when it does not wrap. */
export const wrapSelection = (state: EditorState, from: number, to: number, typed: string): Transaction | null => {
    const plan = planWrap(state, from, to, typed);

    return plan === REFUSED ? null : plan;
};

/**
 * A marker typed over a selection wraps it. Composition text is left alone, so an IME commit replaces the selection as
 * it does today.
 */
export const wrapSelectionOnTextInput = (view: EditorView, from: number, to: number, typed: string): boolean => {
    if (view.composing) {
        return false;
    }

    const plan = planWrap(view.state, from, to, typed);

    // A marker the Markdown would not render is dropped and the selection stays: typing over it would lose the selected text.
    if (plan === REFUSED) {
        return true;
    }

    if (plan === null) {
        return false;
    }

    view.dispatch(plan);

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
