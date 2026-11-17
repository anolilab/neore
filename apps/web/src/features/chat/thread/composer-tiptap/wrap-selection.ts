import { Extension } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

type Marker = "`" | "*" | "_";

const MARKERS: ReadonlySet<string> = new Set(["*", "_", "`"]);

const isMarker = (typed: string): typed is Marker => MARKERS.has(typed);

/**
 * The delimiters a marker wraps `body` in. The composer sends its text as Markdown and its bold, italic and code marks
 * are off, so the delimiters are the formatting.
 */
const delimitersFor = (marker: Marker, body: string): [string, string] => {
    if (marker === "`") {
        // A fence longer than any backtick run in the code keeps it one code span; a space pads a backtick at an edge.
        const longestRun = Math.max(0, ...Array.from(body.matchAll(/`+/g), (run) => run[0].length));
        const fence = "`".repeat(longestRun + 1);
        const pad = body.startsWith("`") || body.endsWith("`") ? " " : "";

        return [`${fence}${pad}`, `${pad}${fence}`];
    }

    if (marker === "*") {
        return ["**", "**"];
    }

    return ["_", "_"];
};

/**
 * The transaction that wraps the selection `from`..`to` in the delimiters `typed` stands for, leaving the wrapped text
 * selected in the same direction. Whitespace at the edges stays outside the delimiters, where Markdown can use it.
 *
 * Returns `null` when the typed text is no marker, nothing is selected, the selection is not inside one textblock (a
 * select-all or a range over several paragraphs), it holds a node other than text (a quote chip, a line break), or it
 * is only whitespace. Typing then replaces the selection as it always did.
 */
export const wrapSelection = (state: EditorState, from: number, to: number, typed: string): Transaction | null => {
    if (!isMarker(typed) || from === to) {
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
    const [open, close] = delimitersFor(typed, body);
    const transaction = state.tr.insertText(`${selected.slice(0, lead)}${open}${body}${close}${trail}`, from, to);
    const innerStart = from + lead + open.length;
    const innerEnd = innerStart + body.length;
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
