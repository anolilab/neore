/* eslint-disable unicorn/max-nested-calls -- the assertions read best as `expect(offsetOf(press(...).state))` */
import { history } from "@tiptap/pm/history";
import { Schema } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
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

/** The composer's schema: a paragraph holds text and Shift+Enter hard breaks, which are the lines Vim moves between. */
const breakSchema = new Schema({
    nodes: {
        doc: { content: "paragraph+" },
        hardBreak: { group: "inline", inline: true, leafText: () => "\n", selectable: false },
        paragraph: { content: "inline*", toDOM: () => ["p", 0] },
        text: { group: "inline" },
    },
});

/** The composer's schema with a quote chip: a block that holds no text, between paragraphs. */
const chipSchema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { content: "text*", group: "block", toDOM: () => ["p", 0] },
        quoteChip: { atom: true, group: "block", toDOM: () => ["div"] },
        text: {},
    },
});

/** The chip schema with Shift+Enter hard breaks, for displayed lines next to a chip. */
const breakChipSchema = new Schema({
    nodes: {
        doc: { content: "block+" },
        hardBreak: { group: "inline", inline: true, leafText: () => "\n", selectable: false },
        paragraph: { content: "inline*", group: "block", toDOM: () => ["p", 0] },
        quoteChip: { atom: true, group: "block", toDOM: () => ["div"] },
        text: { group: "inline" },
    },
});

/** A paragraph "first", a chip, then a paragraph "last", with the cursor at the start of "last". */
const aroundChip = (): EditorState => {
    const doc = chipSchema.node("doc", null, [
        chipSchema.node("paragraph", null, [chipSchema.text("first")]),
        chipSchema.node("quoteChip"),
        chipSchema.node("paragraph", null, [chipSchema.text("last")]),
    ]);
    const state = EditorState.create({ doc, schema: chipSchema });

    return state.apply(state.tr.setSelection(TextSelection.create(doc, doc.content.size - 5)));
};

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

    it("leaves Escape to prompt history while a recalled prompt is showing", () => {
        const result = runVimKey(hello(5), INITIAL_VIM_STATE, key("Escape"), true);

        expect(result.handled).toBe(false);
        expect(result.state.mode).toBe("insert");
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

    it("passes over a quote chip with k and after dd, staying on a line it can act on", () => {
        expect(press(aroundChip(), ["k"]).state.selection.$head.parent.textContent).toBe("first");
        expect(press(aroundChip(), ["d", "d"]).state.selection.$head.parent.isTextblock).toBe(true);
    });

    it("acts on a selected quote chip with x, a and i, and types nothing over it", () => {
        const start = aroundChip();
        const chipSelected = start.apply(start.tr.setSelection(NodeSelection.create(start.doc, 7)));

        expect(press(chipSelected, ["z"]).handled).toBe(true);
        expect(press(chipSelected, ["z"]).state.doc.childCount).toBe(3);
        expect(press(chipSelected, ["x"]).state.doc.childCount).toBe(2);

        const after = press(chipSelected, ["a"]);

        expect(after.vim.mode).toBe("insert");
        expect(after.state.selection.$head.parent.textContent).toBe("last");

        // Motions leave the chip, `dd` deletes it, and the chip's line count is what `o` changes.
        expect(press(chipSelected, ["j"]).state.selection.$head.parent.textContent).toBe("last");
        expect(press(chipSelected, ["k"]).state.selection.$head.parent.textContent).toBe("first");
        expect(press(chipSelected, ["d", "d"]).state.doc.childCount).toBe(2);
        // `d` then another key cancels the operator: the chip stays.
        expect(press(chipSelected, ["d", "x"]).state.doc.childCount).toBe(3);
        // `I` and `A` go to the start and the end of the line before and after, `i` and `a` stay next to the chip.
        expect(offsetOf(press(chipSelected, ["I"]).state)).toBe(0);
        expect(offsetOf(press(chipSelected, ["A"]).state)).toBe(4);

        // `o` opens a new, empty line after the chip rather than joining "last".
        const opened = press(chipSelected, ["o"]);

        expect(opened.state.doc.childCount).toBe(4);
        expect(opened.state.selection.$head.parent.textContent).toBe("");
        expect(opened.state.doc.child(1).type.name).toBe("quoteChip");
    });

    it("places I and A on the displayed line next to a chip, not the whole paragraph", () => {
        const lineBreak = breakChipSchema.nodes.hardBreak!.create();
        const doc = breakChipSchema.node("doc", null, [
            breakChipSchema.node("paragraph", null, [breakChipSchema.text("ab"), lineBreak, breakChipSchema.text("  cd")]),
            breakChipSchema.node("quoteChip"),
            breakChipSchema.node("paragraph", null, [breakChipSchema.text("ef"), lineBreak, breakChipSchema.text("gh")]),
        ]);
        const start = EditorState.create({ doc, schema: breakChipSchema });
        const selected = start.apply(start.tr.setSelection(NodeSelection.create(doc, 9)));

        // `I`: "c", the first non-space of the last line before the chip (position 6); `A`: after "ef", the first line after (13).
        expect(press(selected, ["I"]).state.selection.from).toBe(6);
        expect(press(selected, ["A"]).state.selection.from).toBe(13);
    });

    it("moves left off a selected chip with Backspace instead of deleting it", () => {
        const start = aroundChip();
        const chipSelected = start.apply(start.tr.setSelection(NodeSelection.create(start.doc, 7)));
        const result = press(chipSelected, ["Backspace"]);

        expect(result.handled).toBe(true);
        expect(result.state.doc.childCount).toBe(3);
        expect(result.state.selection.$head.parent.textContent).toBe("first");

        // After `d`, Backspace cancels the operator; it is still not passed on to the editor, whose Backspace deletes the chip.
        const cancelled = press(chipSelected, ["d", "Backspace"]);

        expect(cancelled.handled).toBe(true);
        expect(cancelled.state.doc.childCount).toBe(3);
        expect(cancelled.vim.pending).toBe("");
    });

    it.each(["h", "k", "Backspace"])("%s off a chip lands on the last character of the line before, where x deletes it", (motion) => {
        const start = aroundChip();
        const chipSelected = start.apply(start.tr.setSelection(NodeSelection.create(start.doc, 7)));

        expect(lines(press(chipSelected, [motion, "x"]).state)).toStrictEqual(["firs", "", "last"]);
    });

    it("leaves a chip onto the displayed line next to it: b to its last word, w to its first non-space", () => {
        const lineBreak = breakChipSchema.nodes.hardBreak!.create();
        const doc = breakChipSchema.node("doc", null, [
            breakChipSchema.node("paragraph", null, [breakChipSchema.text("ab"), lineBreak, breakChipSchema.text("cd ef")]),
            breakChipSchema.node("quoteChip"),
            breakChipSchema.node("paragraph", null, [breakChipSchema.text("  gh")]),
            breakChipSchema.node("paragraph"),
        ]);
        const start = EditorState.create({ doc, schema: breakChipSchema });
        const selected = start.apply(start.tr.setSelection(NodeSelection.create(doc, 10)));

        // "ef" starts at offset 6 of the paragraph before; "g" is at offset 2 of the one after.
        expect(offsetOf(press(selected, ["b"]).state)).toBe(6);
        expect(offsetOf(press(selected, ["w"]).state)).toBe(2);

        // An empty line before the chip: the cursor sits at its start.
        const empty = breakChipSchema.node("doc", null, [breakChipSchema.node("paragraph"), breakChipSchema.node("quoteChip")]);
        const emptyStart = EditorState.create({ doc: empty, schema: breakChipSchema });

        expect(offsetOf(press(emptyStart.apply(emptyStart.tr.setSelection(NodeSelection.create(empty, 2))), ["h"]).state)).toBe(0);
    });

    it("opens a line before a quote chip that starts the draft, so i does not type over it", () => {
        const doc = chipSchema.node("doc", null, [chipSchema.node("quoteChip"), chipSchema.node("paragraph", null, [chipSchema.text("comment")])]);
        const start = EditorState.create({ doc, schema: chipSchema });
        const chipSelected = start.apply(start.tr.setSelection(NodeSelection.create(start.doc, 0)));
        const { state, vim } = press(chipSelected, ["i"]);

        expect(vim.mode).toBe("insert");
        expect(state.selection.$head.parent.isTextblock).toBe(true);
        expect(state.doc.child(1).type.name).toBe("quoteChip");
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

    it("cancels a pending d on a key that is not a motion, and keeps that key's own meaning", () => {
        const enter = press(hello(0), ["d", "Enter"]);

        expect(enter.handled).toBe(false);
        expect(enter.vim.pending).toBe("");
        expect(lines(enter.state)).toStrictEqual(["hello world"]);
        expect(press(hello(0), ["d", "Tab"]).handled).toBe(false);
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

/** `paragraphs[i]` is the displayed lines of paragraph i; each line after the first starts after a hard break. */
const brokenState = (paragraphs: string[][], cursor: number): EditorState => {
    const doc = breakSchema.node(
        "doc",
        null,
        paragraphs.map((segments) =>
            breakSchema.node(
                "paragraph",
                null,
                segments.flatMap((segment, index) => [...(index > 0 ? [breakSchema.node("hardBreak")] : []), ...(segment ? [breakSchema.text(segment)] : [])]),
            ),
        ),
    );
    const state = EditorState.create({ doc, plugins: [history()], schema: breakSchema });

    return state.apply(state.tr.setSelection(TextSelection.create(doc, cursor)));
};

/** The displayed lines of each paragraph, as the cursor sees them. */
const displayed = (state: EditorState): string[][] =>
    state.doc.children.map((paragraph) => paragraph.textBetween(0, paragraph.content.size, undefined, "\n").split("\n"));

describe("displayed lines split at hard breaks", () => {
    // One paragraph: "one", "two", "three" (breaks at offsets 3, 7). "two" starts at offset 4, "three" at 8.
    const three = [["one", "two", "three"]];

    it("dd on the first line removes it and its break, leaving the cursor on the next line", () => {
        const result = press(brokenState(three, 1), ["d", "d"]);

        expect(displayed(result.state)).toStrictEqual([["two", "three"]]);
        expect(offsetOf(result.state)).toBe(0);
    });

    it("dd on the middle line removes only that line", () => {
        const result = press(brokenState(three, 5), ["d", "d"]);

        expect(displayed(result.state)).toStrictEqual([["one", "three"]]);
        expect(offsetOf(result.state)).toBe(4);
    });

    it("dd on the last line removes it with the break before it", () => {
        const result = press(brokenState(three, 9), ["d", "d"]);

        expect(displayed(result.state)).toStrictEqual([["one", "two"]]);
    });

    it("j and k move between displayed lines, keeping the column", () => {
        const down = press(brokenState(three, 2), ["j"]);

        expect(offsetOf(down.state)).toBe(4 + 1);

        const up = press(brokenState(three, 11), ["k"]);

        expect(offsetOf(up.state)).toBe(4 + 3 - 1);
    });

    it("j crosses from one paragraph's last line into the next paragraph", () => {
        const result = press(brokenState([["ab", "cd"], ["ef"]], 5), ["j"]);

        expect(result.state.selection.$head.index(0)).toBe(1);
    });

    it("$, 0 and D work on the line the cursor is in", () => {
        expect(offsetOf(press(brokenState(three, 5), ["$"]).state)).toBe(4 + 2);
        expect(offsetOf(press(brokenState(three, 6), ["0"]).state)).toBe(4);
        expect(displayed(press(brokenState(three, 6), ["D"]).state)).toStrictEqual([["one", "t", "three"]]);
    });

    it("x just before a break deletes nothing, so the two lines stay apart", () => {
        const result = press(brokenState([["one", "two"]], 4), ["x"]);

        expect(displayed(result.state)).toStrictEqual([["one", "two"]]);
        expect(offsetOf(result.state)).toBe(3);
    });

    it("A appends at the end of the displayed line, before its break", () => {
        const result = press(brokenState(three, 5), ["A"]);

        expect(offsetOf(result.state)).toBe(4 + 3);
        expect(result.vim.mode).toBe("insert");
    });

    it("o opens a displayed line below, as a new hard break, and O above", () => {
        const below = press(brokenState(three, 5), ["o"]);

        expect(displayed(below.state)).toStrictEqual([["one", "two", "", "three"]]);
        expect(offsetOf(below.state)).toBe(8);

        const above = press(brokenState(three, 5), ["O"]);

        expect(displayed(above.state)).toStrictEqual([["one", "", "two", "three"]]);
        expect(offsetOf(above.state)).toBe(4);
    });

    it("a paragraph that starts with a break has an empty first line the cursor can sit on", () => {
        const result = press(brokenState([["", "one"]], 1), ["j"]);

        expect(displayed(result.state)).toStrictEqual([["", "one"]]);
        expect(offsetOf(result.state)).toBe(1);
    });
});
