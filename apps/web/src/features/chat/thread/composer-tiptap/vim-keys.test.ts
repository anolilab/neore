/* eslint-disable unicorn/max-nested-calls -- the assertions read best as `expect(offsetOf(press(...).state))` */
import { history } from "@tiptap/pm/history";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import type { VimKey, VimState } from "./vim-keys";
import { INITIAL_VIM_STATE, nextWordStart, previousWordStart, runVimKey } from "./vim-keys";

const schema = new Schema({
    nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", toDOM: () => ["p", 0] },
        text: {},
    },
});

const NORMAL: VimState = { mode: "normal", pending: "" };

const stateOf = (lines: string[], cursor: number): EditorState => {
    const doc = schema.node(
        "doc",
        null,
        lines.map((line) => schema.node("paragraph", null, line ? [schema.text(line)] : [])),
    );
    const state = EditorState.create({ doc, plugins: [history()], schema });

    return state.apply(state.tr.setSelection(TextSelection.create(doc, cursor)));
};

const key = (name: string, modifiers: Partial<VimKey> = {}): VimKey => {
    return { altKey: false, ctrlKey: false, key: name, metaKey: false, ...modifiers };
};

/** Types keys in sequence; returns the end state, vim state and what the last key reported. */
const press = (start: EditorState, keys: string[], vim: VimState = NORMAL) => {
    let state = start;
    let current = vim;
    let handled = false;

    for (const name of keys) {
        const result = runVimKey(state, current, key(name));

        if (result.tr) {
            state = state.apply(result.tr);
        }

        current = result.state;
        handled = result.handled;
    }

    return { handled, state, text: state.doc.textContent, vim: current };
};

const lines = (state: EditorState): string[] => state.doc.children.map((child) => child.textContent);
const offsetOf = (state: EditorState): number => state.selection.$head.parentOffset;

// "hello world" starts at position 1; offsets below are into the line.
const hello = (offset: number): EditorState => stateOf(["hello world"], 1 + offset);

describe("word motions", () => {
    it("finds the next word start, treating punctuation as its own word", () => {
        expect(nextWordStart("foo bar", 0)).toBe(4);
        expect(nextWordStart("foo.bar", 0)).toBe(3);
        expect(nextWordStart("foo  ", 0)).toBe(5);
    });

    it("finds the previous word start", () => {
        expect(previousWordStart("foo bar", 5)).toBe(4);
        expect(previousWordStart("foo bar", 4)).toBe(0);
        expect(previousWordStart("foo", 0)).toBe(0);
    });
});

describe("modes", () => {
    it("Escape leaves insert mode and steps the cursor back onto a character", () => {
        const { handled, state, vim } = press(hello(5), ["Escape"], INITIAL_VIM_STATE);

        expect(handled).toBe(true);
        expect(vim.mode).toBe("normal");
        expect(offsetOf(state)).toBe(4);
    });

    it("leaves every key alone in insert mode", () => {
        const result = runVimKey(hello(0), INITIAL_VIM_STATE, key("h"));

        expect(result.handled).toBe(false);
        expect(result.tr).toBeUndefined();
    });

    it("lets Escape through in normal mode, for cancelling a reply", () => {
        expect(press(hello(0), ["Escape"]).handled).toBe(false);
    });

    it.each([
        ["i", 3, 3],
        ["a", 3, 4],
        ["I", 3, 0],
        ["A", 3, 11],
    ])("%s from offset %d enters insert mode at offset %d", (command, from, to) => {
        const { state, vim } = press(hello(from), [command]);

        expect(vim.mode).toBe("insert");
        expect(offsetOf(state)).toBe(to);
    });
});

describe("motions", () => {
    it("moves with h and l, and stops on the last character", () => {
        expect(offsetOf(press(hello(3), ["h"]).state)).toBe(2);
        expect(offsetOf(press(hello(0), ["h"]).state)).toBe(0);
        expect(offsetOf(press(hello(10), ["l"]).state)).toBe(10);
    });

    it("jumps with 0, ^ and $", () => {
        expect(offsetOf(press(hello(5), ["0"]).state)).toBe(0);
        expect(offsetOf(press(stateOf(["  hi"], 4), ["^"]).state)).toBe(2);
        expect(offsetOf(press(hello(0), ["$"]).state)).toBe(10);
    });

    it("moves by word with w and b, across lines", () => {
        expect(offsetOf(press(hello(0), ["w"]).state)).toBe(6);
        expect(offsetOf(press(hello(8), ["b"]).state)).toBe(6);

        const twoLines = press(stateOf(["one", "two"], 3), ["w"]);

        expect(twoLines.state.selection.$head.index(0)).toBe(1);
    });

    it("moves between lines with j and k, clamping the column", () => {
        const down = press(stateOf(["hello", "hi"], 5), ["j"]);

        expect(down.state.selection.$head.index(0)).toBe(1);
        expect(offsetOf(down.state)).toBe(1);
        expect(press(stateOf(["only"], 2), ["j"]).handled).toBe(true);
    });
});

describe("editing", () => {
    it("deletes the character under the cursor with x, keeping the cursor on text", () => {
        const { state, text } = press(stateOf(["abc"], 3), ["x"]);

        expect(text).toBe("ab");
        expect(offsetOf(state)).toBe(1);
    });

    it("deletes to the end of the line with D", () => {
        const { state } = press(hello(5), ["D"]);

        expect(lines(state)).toStrictEqual(["hello"]);
    });

    it("deletes a line with dd, and empties a lone line", () => {
        expect(lines(press(stateOf(["one", "two", "three"], 6), ["d", "d"]).state)).toStrictEqual(["one", "three"]);
        expect(lines(press(stateOf(["only"], 2), ["d", "d"]).state)).toStrictEqual([""]);
    });

    it("cancels an operator that is not completed", () => {
        const { state, vim } = press(hello(0), ["d", "x"]);

        expect(lines(state)).toStrictEqual(["hello world"]);
        expect(vim.pending).toBe("");
    });

    it("opens a line below with o and above with O, in insert mode", () => {
        const below = press(stateOf(["one", "two"], 2), ["o"]);

        expect(lines(below.state)).toStrictEqual(["one", "", "two"]);
        expect(below.vim.mode).toBe("insert");
        expect(below.state.selection.$head.index(0)).toBe(1);
        expect(lines(press(stateOf(["one"], 2), ["O"]).state)).toStrictEqual(["", "one"]);
    });

    it("undoes with u", () => {
        const deleted = press(stateOf(["abc"], 1), ["x"]);
        const undone = press(deleted.state, ["u"]);

        expect(undone.text).toBe("abc");
    });
});

describe("what normal mode leaves alone", () => {
    it("does not type letters or symbols", () => {
        const result = press(hello(0), ["z"]);

        expect(result.handled).toBe(true);
        expect(result.text).toBe("hello world");
    });

    it.each(["Enter", "Tab", "ArrowUp", "ArrowLeft", "Delete", "F5"])("passes %s through", (name) => {
        expect(press(hello(0), [name]).handled).toBe(false);
    });

    it("passes modifier chords through, so Ctrl+Enter and the app shortcuts keep working", () => {
        expect(runVimKey(hello(0), NORMAL, key("j", { ctrlKey: true })).handled).toBe(false);
        expect(runVimKey(hello(0), NORMAL, key("k", { metaKey: true })).handled).toBe(false);
        expect(runVimKey(hello(0), NORMAL, key("x", { altKey: true })).handled).toBe(false);
    });
});
