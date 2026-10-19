/**
 * The composer's opt-in Vim keys, as pure functions over a ProseMirror state so
 * they test without a browser. `extensions/vim-mode.ts` is the glue.
 *
 * A deliberately small subset, enough to edit a prompt: modes (insert / normal),
 * `h j k l w b 0 ^ $` motions, `i a I A o O` to insert, `x D dd` to delete and `u`
 * to undo. A "line" is a paragraph (Shift+Enter starts one). There are no counts,
 * registers (so no yank/paste), visual mode or `.` repeat; `j`/`k` do not remember
 * a preferred column.
 */
import { undo } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";

export type VimMode = "insert" | "normal";

export interface VimState {
    mode: VimMode;
    /** The first key of a two-key command (`d` of `dd`). */
    pending: "" | "d";
}

export const INITIAL_VIM_STATE: VimState = { mode: "insert", pending: "" };

/** The fields of a `KeyboardEvent` these keys read. */
export interface VimKey {
    altKey: boolean;
    ctrlKey: boolean;
    key: string;
    metaKey: boolean;
}

export interface VimResult {
    /** The key was consumed; the editor must not also act on it. */
    handled: boolean;
    state: VimState;
    /** The document or cursor change. Absent for a pure mode change. */
    tr?: Transaction;
}

const WORD_CHARACTER = /\w/;
const SPACE = /\s/;

/** 0 = space, 1 = word character, 2 = punctuation: Vim's "word" is a run of one class. */
const classOf = (character: string): 0 | 1 | 2 => {
    if (SPACE.test(character)) {
        return 0;
    }

    return WORD_CHARACTER.test(character) ? 1 : 2;
};

export const nextWordStart = (text: string, from: number): number => {
    let index = from;
    const start = classOf(text[index] ?? " ");

    while (index < text.length && start !== 0 && classOf(text[index]!) === start) {
        index += 1;
    }

    while (index < text.length && classOf(text[index]!) === 0) {
        index += 1;
    }

    return index;
};

export const previousWordStart = (text: string, from: number): number => {
    let index = from - 1;

    while (index > 0 && classOf(text[index]!) === 0) {
        index -= 1;
    }

    if (index <= 0) {
        return 0;
    }

    const wordClass = classOf(text[index]!);

    while (index > 0 && classOf(text[index - 1]!) === wordClass) {
        index -= 1;
    }

    return index;
};

const NON_SPACE = /\S/;

const firstNonSpace = (text: string): number => {
    const index = text.search(NON_SPACE);

    return index === -1 ? 0 : index;
};

interface Line {
    index: number;
    /** Document position of the line's first character. */
    start: number;
    text: string;
}

const lineAt = (doc: ProseMirrorNode, index: number): Line => {
    let start = 1;

    for (let before = 0; before < index; before += 1) {
        start += doc.child(before).nodeSize;
    }

    const paragraph = doc.child(index);

    return { index, start, text: paragraph.textBetween(0, paragraph.content.size, undefined, "\n") };
};

/** The cursor's line and its offset into it, or `null` when the cursor is not inside a paragraph. */
const cursorOf = (state: EditorState): { line: Line; offset: number } | null => {
    const { $head } = state.selection;

    if (!$head.parent.isTextblock) {
        return null;
    }

    return { line: lineAt(state.doc, $head.index(0)), offset: $head.parentOffset };
};

/** In normal mode the cursor sits ON a character, so the last valid offset is `length - 1`. */
const lastOffset = (line: Line): number => Math.max(0, line.text.length - 1);

const moveTo = (state: EditorState, position: number): Transaction => state.tr.setSelection(TextSelection.create(state.doc, position));

const handledAt = (vim: VimState, tr: Transaction | undefined, next: Partial<VimState> = {}): VimResult => {
    return { handled: true, state: { ...vim, pending: "", ...next }, tr };
};

const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max);

const move = (state: EditorState, vim: VimState, line: Line, offset: number): VimResult => {
    const position = line.start + clamp(offset, lastOffset(line));

    return handledAt(vim, moveTo(state, position));
};

const enterInsert = (state: EditorState, vim: VimState, line: Line, offset: number): VimResult => {
    const position = line.start + clamp(offset, line.text.length);

    return handledAt(vim, moveTo(state, position), { mode: "insert" });
};

const openLine = (state: EditorState, vim: VimState, line: Line, below: boolean): VimResult => {
    const { paragraph } = state.schema.nodes;
    const at = below ? line.start - 1 + state.doc.child(line.index).nodeSize : line.start - 1;
    const tr = state.tr.insert(at, paragraph!.create());

    return handledAt(vim, tr.setSelection(TextSelection.create(tr.doc, at + 1)), { mode: "insert" });
};

const deleteLine = (state: EditorState, vim: VimState, line: Line): VimResult => {
    const { paragraph } = state.schema.nodes;
    const from = line.start - 1;
    const to = from + state.doc.child(line.index).nodeSize;

    if (state.doc.childCount === 1) {
        const tr = state.tr.replaceWith(from, to, paragraph!.create());

        return handledAt(vim, tr.setSelection(TextSelection.create(tr.doc, 1)));
    }

    const tr = state.tr.delete(from, to);
    const target = lineAt(tr.doc, Math.min(line.index, tr.doc.childCount - 1));

    const cursor = target.start + Math.min(firstNonSpace(target.text), lastOffset(target));

    return handledAt(vim, tr.setSelection(TextSelection.create(tr.doc, cursor)));
};

const deleteRange = (state: EditorState, vim: VimState, line: Line, offset: number, length: number): VimResult => {
    if (line.text.length === 0) {
        return handledAt(vim, undefined);
    }

    const tr = state.tr.delete(line.start + offset, line.start + offset + length);
    const remaining = line.text.length - length;
    const cursor = Math.min(offset, Math.max(0, remaining - 1));

    return handledAt(vim, tr.setSelection(TextSelection.create(tr.doc, line.start + cursor)));
};

const runUndo = (state: EditorState, vim: VimState): VimResult => {
    let tr: Transaction | undefined;

    undo(state, (transaction) => {
        tr = transaction;
    });

    return handledAt(vim, tr);
};

const normalKey = (state: EditorState, vim: VimState, key: string): VimResult => {
    const cursor = cursorOf(state);

    if (!cursor) {
        return { handled: false, state: vim };
    }

    const { line, offset } = cursor;

    if (vim.pending === "d") {
        // `dd` deletes the line; anything else cancels the operator and is handled as usual.
        return key === "d" ? deleteLine(state, vim, line) : { handled: key.length === 1, state: { ...vim, pending: "" } };
    }

    switch (key) {
        case "0": {
            return move(state, vim, line, 0);
        }
        case "$": {
            return move(state, vim, line, lastOffset(line));
        }
        case "^": {
            return move(state, vim, line, firstNonSpace(line.text));
        }
        case "a": {
            return enterInsert(state, vim, line, offset + 1);
        }
        case "A": {
            return enterInsert(state, vim, line, line.text.length);
        }
        case "b": {
            if (offset === 0 && line.index > 0) {
                const preceding = lineAt(state.doc, line.index - 1);

                return move(state, vim, preceding, previousWordStart(preceding.text, preceding.text.length));
            }

            return move(state, vim, line, previousWordStart(line.text, offset));
        }
        case "Backspace":
        case "h": {
            return move(state, vim, line, offset - 1);
        }
        case "D": {
            return deleteRange(state, vim, line, offset, line.text.length - offset);
        }
        case "d": {
            return handledAt(vim, undefined, { pending: "d" });
        }
        case "i": {
            return enterInsert(state, vim, line, offset);
        }
        case "I": {
            return enterInsert(state, vim, line, firstNonSpace(line.text));
        }
        case "j":
        case "k": {
            const index = line.index + (key === "j" ? 1 : -1);

            return index < 0 || index >= state.doc.childCount ? handledAt(vim, undefined) : move(state, vim, lineAt(state.doc, index), offset);
        }
        case "l": {
            return move(state, vim, line, offset + 1);
        }
        case "o":
        case "O": {
            return openLine(state, vim, line, key === "o");
        }
        case "u": {
            return runUndo(state, vim);
        }
        case "w": {
            const next = nextWordStart(line.text, offset);

            if (next >= line.text.length && line.index < state.doc.childCount - 1) {
                const following = lineAt(state.doc, line.index + 1);

                return move(state, vim, following, firstNonSpace(following.text));
            }

            return move(state, vim, line, next);
        }
        case "x": {
            return deleteRange(state, vim, line, offset, 1);
        }
        default: {
            // A letter or symbol must not type into the text; Enter, Tab, arrows and the like keep their meaning.
            return { handled: key.length === 1, state: vim };
        }
    }
};

/**
 * Runs one key press. `handled: false` leaves the key to the rest of the editor.
 * `historyRecalled`: a recalled prompt is showing, so insert-mode Escape belongs to
 * prompt history (it restores the draft) and is not consumed here.
 */
export const runVimKey = (state: EditorState, vim: VimState, event: VimKey, historyRecalled = false): VimResult => {
    if (event.ctrlKey || event.metaKey || event.altKey) {
        return { handled: false, state: vim };
    }

    if (vim.mode === "insert") {
        if (event.key !== "Escape" || historyRecalled) {
            return { handled: false, state: vim };
        }

        const cursor = cursorOf(state);

        return handledAt(vim, cursor ? moveTo(state, cursor.line.start + Math.max(0, cursor.offset - 1)) : undefined, { mode: "normal" });
    }

    if (event.key === "Escape") {
        // Falls through (cancelling a running reply, restoring recalled history); only the operator is dropped.
        return { handled: false, state: { ...vim, pending: "" } };
    }

    return normalKey(state, vim, event.key);
};
