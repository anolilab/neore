import { findHiddenText, stripHiddenText } from "@neore/ai/utils";
import { describe, expect, it } from "vitest";

import { caretAfterRemoval } from "./host-caret";

describe("caretAfterRemoval", () => {
    it("leaves a caret alone when nothing before it was removed", () => {
        expect(caretAfterRemoval(3, [])).toBe(3);
        expect(caretAfterRemoval(3, [{ index: 5, length: 1 }])).toBe(3);
    });

    it("moves a caret back by each removed unit before it", () => {
        // "ab‮cd": the bidi override sits at 2; a caret after it (3) moves back to 2.
        expect(caretAfterRemoval(3, [{ index: 2, length: 1 }])).toBe(2);
        // A caret at the end of a value with two removals before it.
        expect(
            caretAfterRemoval(6, [
                { index: 1, length: 1 },
                { index: 3, length: 2 },
            ]),
        ).toBe(3);
    });

    it("counts a surrogate pair as two units, so a removal inside the caret's span moves it by what it covers", () => {
        const tagged = "a\u{E0041}b";

        expect(caretAfterRemoval(tagged.length, findHiddenText(tagged, { keepTrailingJoiner: true }))).toBe(2);
    });

    it("puts the caret where the person left it in a draft with a removal inserted before it", () => {
        // Typing "x" after a bidi override that was already in the draft: the caret sits after both.
        const raw = "\u{202E}hello x";
        const { text } = stripHiddenText(raw, { keepTrailingJoiner: true });
        const caret = caretAfterRemoval(raw.length, findHiddenText(raw, { keepTrailingJoiner: true }));

        expect(text.slice(0, caret)).toBe(text);
    });
});
