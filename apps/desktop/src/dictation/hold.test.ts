import { describe, expect, it } from "vitest";

import { DICTATION_LETTER, isCancel, isChordRelease } from "./hold.js";

describe("hold detection", () => {
    it.each([DICTATION_LETTER.toLowerCase(), DICTATION_LETTER, "Shift", "Meta", "Control"])("ends on the key-up of %s", (key) => {
        expect(isChordRelease({ key, type: "keyUp" })).toBe(true);
    });

    it("does not end on a key-down, on the repeat of a held key, or on another key", () => {
        expect(isChordRelease({ key: DICTATION_LETTER.toLowerCase(), type: "keyDown" })).toBe(false);
        expect(isChordRelease({ key: "a", type: "keyUp" })).toBe(false);
        expect(isChordRelease({ key: "Escape", type: "keyUp" })).toBe(false);
    });

    it("cancels on Escape", () => {
        expect(isCancel({ key: "Escape", type: "keyDown" })).toBe(true);
        expect(isCancel({ key: "Escape", type: "keyUp" })).toBe(false);
        expect(isCancel({ key: DICTATION_LETTER.toLowerCase(), type: "keyDown" })).toBe(false);
    });
});
