import { describe, expect, it } from "vitest";

import { hasHiddenText, showHidden, stripHiddenText } from "./hidden-text";

describe("hasHiddenText", () => {
    it("is stateless across calls", () => {
        for (let call = 0; call < 4; call += 1) {
            expect(hasHiddenText("a\u{202E}b")).toBe(true);
        }
    });

    it("lets layout through only when asked", () => {
        expect(hasHiddenText("a\nb\tc")).toBe(true);
        expect(hasHiddenText("a\nb\tc", { layout: true })).toBe(false);
        expect(hasHiddenText("a\rb", { layout: true })).toBe(true);
    });

    it("takes ordinary text, accents and emoji without a joiner", () => {
        expect(hasHiddenText("Überprüfe src/ä.ts 👍")).toBe(false);
    });
});

describe("showHidden", () => {
    it("replaces each hidden character with a visible mark", () => {
        expect(showHidden("a\u{202E}b\u{E0041}c\nd")).toBe("a?b?c?d");
    });
});

describe("stripHiddenText", () => {
    it("removes tag characters, bidi controls, separators and C0 controls, and counts them", () => {
        const tagged = [..."ignore"].map((character) => String.fromCodePoint(0xe_00_00 + character.codePointAt(0)!)).join("");

        expect(stripHiddenText(`a${tagged}b\u{202E}c\u{2028}d\u{7}e\u{200B}f`)).toEqual({ removed: 6 + 4, text: "abcdef" });
    });

    it("keeps newlines, tabs, accents and emoji", () => {
        expect(stripHiddenText("Über\n\tprüfe 👍")).toEqual({ removed: 0, text: "Über\n\tprüfe 👍" });
    });

    it("keeps joiners: a ZWJ emoji family, a flag-free VS16 emoji and a Persian word with ZWNJ", () => {
        const family = "👨\u{200D}👩\u{200D}👧";
        const heart = "❤\u{FE0F}";
        const persian = "می\u{200C}خواهم";

        expect(stripHiddenText(`${family} ${heart} ${persian}`)).toEqual({ removed: 0, text: `${family} ${heart} ${persian}` });
        expect(hasHiddenText(family + persian)).toBe(false);
        expect(showHidden(family + persian)).toBe(family + persian);
    });

    it("still removes a tag payload, RLO and ZWSP beside joiners", () => {
        expect(stripHiddenText("👨\u{200D}👩\u{E0041}\u{202E}\u{200B}x")).toEqual({ removed: 3, text: "👨\u{200D}👩x" });
    });

    it("is stateless across calls", () => {
        for (let call = 0; call < 3; call += 1) {
            expect(stripHiddenText("a\u{E0041}b").removed).toBe(1);
        }
    });
});
