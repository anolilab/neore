import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import { canAcceptGhost } from "./ghost-completion";

const schema = new Schema({
    nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", toDOM: () => ["p", 0] },
        text: {},
    },
});

/** Two paragraphs, "hello" and "world"; positions: "hello" is 1–6, "world" is 8–13. */
const stateAt = (anchor: number, head: number = anchor): EditorState => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("hello")]), schema.node("paragraph", null, [schema.text("world")])]);
    const state = EditorState.create({ doc, schema });

    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, anchor, head)));
};

describe(canAcceptGhost, () => {
    it("accepts with the caret at the ghost, at the end of its line", () => {
        expect(canAcceptGhost(stateAt(6), { pos: 6, text: " there" })).toBe(true);
        expect(canAcceptGhost(stateAt(13), { pos: 13, text: "!" })).toBe(true);
    });

    it("leaves Right Arrow alone mid-line, away from the ghost, over a selection or without one", () => {
        expect(canAcceptGhost(stateAt(3), { pos: 3, text: "x" })).toBe(false);
        expect(canAcceptGhost(stateAt(13), { pos: 6, text: "x" })).toBe(false);
        expect(canAcceptGhost(stateAt(1, 6), { pos: 6, text: "x" })).toBe(false);
        expect(canAcceptGhost(stateAt(6), null)).toBe(false);
    });
});
