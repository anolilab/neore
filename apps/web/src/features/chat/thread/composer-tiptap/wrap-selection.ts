import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/**
 * The Markdown delimiter each marker wraps a selection in: a backtick for code, two asterisks for bold, an underscore for
 * italic. The composer sends its text as Markdown and its bold, italic and code marks are off, so the delimiters are the
 * formatting.
 */
const WRAP_DELIMITERS: ReadonlyMap<string, string> = new Map([
    ["*", "**"],
    ["_", "_"],
    ["`", "`"],
]);

/**
 * The transaction that wraps the selection `from`..`to` in the delimiter `typed` stands for, leaving the wrapped text
 * selected. Returns `null` when the typed text is no marker, nothing is selected, the selection spans more than one
 * block, or it holds a node other than text (a quote chip, a line break): typing then replaces the selection as it always did.
 */
export const wrapSelection = (state: EditorState, from: number, to: number, typed: string): Transaction | null => {
    const delimiter = WRAP_DELIMITERS.get(typed);

    if (delimiter === undefined || from === to) {
        return null;
    }

    const $from = state.doc.resolve(from);
    const $to = state.doc.resolve(to);

    if (!$from.sameParent($to)) {
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
    const transaction = state.tr.insertText(`${delimiter}${selected}${delimiter}`, from, to);
    const start = from + delimiter.length;

    return transaction.setSelection(TextSelection.create(transaction.doc, start, start + selected.length));
};

/**
 * The editor's `handleTextInput`: a marker typed over a selection wraps it. Composition text is left alone, so an IME
 * commit replaces the selection as it does today.
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
