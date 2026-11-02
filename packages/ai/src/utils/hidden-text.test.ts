import { describe, expect, it } from "vitest";

import { findHiddenText, hasHiddenText, showHidden, stripHiddenText } from "./hidden-text";

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

describe("strict", () => {
    it("counts and shows the joiners that the lenient forms let through", () => {
        expect(hasHiddenText("a\u{200D}b")).toBe(false);
        expect(hasHiddenText("a\u{200D}b", { strict: true })).toBe(true);
        expect(hasHiddenText("a\u{200C}b", { strict: true })).toBe(true);
        expect(showHidden("a\u{200D}b", { strict: true })).toBe("a?b");
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

describe("format characters that render", () => {
    const citation = "\u{600}12 \u{6DD}\u{FD3E}\u{6F1}\u{FD3F} \u{70F}x \u{8E2}1 \u{110BD}2 \u{110CD}3";

    it("keeps a Quranic citation and the other visible format characters", () => {
        expect(hasHiddenText(citation)).toBe(false);
        expect(showHidden(citation)).toBe(citation);
        expect(stripHiddenText(citation)).toEqual({ removed: 0, text: citation });
        expect(findHiddenText(citation)).toEqual([]);
    });

    it("still removes the hidden ones beside them, and the strict forms still count them", () => {
        expect(stripHiddenText(`\u{6DD}1\u{200B}`)).toEqual({ removed: 1, text: "\u{6DD}1" });
        expect(hasHiddenText("\u{6DD}", { strict: true })).toBe(true);
    });
});

const tags = (text: string): string => [...text].map((character) => String.fromCodePoint(0xe_00_00 + (character.codePointAt(0) ?? 0))).join("");
const CANCEL = "\u{E007F}";
const FLAGS = { england: `\u{1F3F4}${tags("gbeng")}${CANCEL}`, scotland: `\u{1F3F4}${tags("gbsct")}${CANCEL}`, wales: `\u{1F3F4}${tags("gbwls")}${CANCEL}` };
// A payload one selector per byte: U+FE00 + n for the low 16, U+E0100 + n above.
const selectors = (count: number): string => Array.from({ length: count }, (_, n) => String.fromCodePoint(n < 16 ? 0xfe_00 + n : 0xe_01_00 + n - 16)).join("");

describe("variation selectors", () => {
    const heart = "\u{2764}\u{FE0F}";
    const ideograph = "\u{8FBB}\u{E0100}";

    it("keeps one selector directly after a base character: an emoji with VS16, a text VS15, a CJK ideograph with an IVS", () => {
        const text = `${heart} \u{2764}\u{FE0E} ${ideograph} 1\u{FE0F}\u{20E3}`;

        expect(stripHiddenText(text)).toEqual({ removed: 0, text });
        expect(hasHiddenText(text)).toBe(false);
        expect(showHidden(text)).toBe(text);
        expect(findHiddenText(text)).toEqual([]);
    });

    it("strips a run of selectors after a letter but its first, and counts them", () => {
        const payload = selectors(20);

        expect(stripHiddenText(`a${payload}b`)).toEqual({ removed: 19, text: `a${payload.slice(0, 1)}b` });
        expect(hasHiddenText(`a${payload}b`)).toBe(true);
        expect(showHidden(`a${payload}b`)).toBe(`a${payload.slice(0, 1)}${"?".repeat(19)}b`);
    });

    it("strips a second selector after an emoji's own, in both blocks", () => {
        expect(stripHiddenText(`${heart}\u{FE0F}\u{E0101}x`)).toEqual({ removed: 2, text: `${heart}x` });
        expect(stripHiddenText(`${ideograph}\u{E0101}`)).toEqual({ removed: 1, text: ideograph });
    });

    it("strips a selector that follows no base character", () => {
        expect(stripHiddenText("\u{FE0F}x")).toEqual({ removed: 1, text: "x" });
        expect(stripHiddenText("a \u{FE0F}")).toEqual({ removed: 1, text: "a " });
        expect(stripHiddenText("a\n\u{FE0F}")).toEqual({ removed: 1, text: "a\n" });
        expect(stripHiddenText("a\u{200D}\u{FE0F}")).toEqual({ removed: 1, text: "a\u{200D}" });
        expect(stripHiddenText("a\u{200B}\u{FE0F}")).toEqual({ removed: 2, text: "a" });
        expect(stripHiddenText("a\u{E0041}\u{FE0F}")).toEqual({ removed: 2, text: "a" });
    });

    it("reports a stripped selector in findHiddenText, an astral one being two units", () => {
        expect(findHiddenText("a\u{FE00}\u{E0100}")).toEqual([{ index: 2, length: 2 }]);
    });

    it("counts every selector in the strict form", () => {
        expect(hasHiddenText(heart)).toBe(false);
        expect(hasHiddenText(heart, { strict: true })).toBe(true);
        expect(hasHiddenText(ideograph, { strict: true })).toBe(true);
        expect(showHidden(`a${heart}`, { strict: true })).toBe("a\u{2764}?");
    });
});

describe("subdivision flags", () => {
    it("keeps the England, Scotland and Wales flags", () => {
        const text = `${FLAGS.england} ${FLAGS.scotland} ${FLAGS.wales}`;

        expect(stripHiddenText(text)).toEqual({ removed: 0, text });
        expect(hasHiddenText(text)).toBe(false);
        expect(showHidden(text)).toBe(text);
        expect(findHiddenText(text)).toEqual([]);
    });

    it("strips a tag payload that does not follow the black flag", () => {
        const payload = `${tags("ignore")}${CANCEL}`;

        expect(stripHiddenText(`a${payload}b`)).toEqual({ removed: 7, text: "ab" });
        expect(stripHiddenText(`\u{1F3F3}${tags("gbeng")}${CANCEL}`).removed).toBe(6);
        expect(stripHiddenText(`\u{1F3F4}\u{200B}${tags("gbeng")}${CANCEL}`).removed).toBe(7);
        expect(hasHiddenText(`a${payload}`)).toBe(true);
    });

    it("strips an unterminated, empty or overlong sequence after the black flag", () => {
        expect(stripHiddenText(`\u{1F3F4}${tags("gbeng")}x`)).toEqual({ removed: 5, text: "\u{1F3F4}x" });
        expect(stripHiddenText(`\u{1F3F4}${CANCEL}`)).toEqual({ removed: 1, text: "\u{1F3F4}" });
        expect(stripHiddenText(`\u{1F3F4}${tags("abcdefg")}${CANCEL}`)).toEqual({ removed: 8, text: "\u{1F3F4}" });
    });

    it("strips tag characters that are not letters or digits even inside the sequence", () => {
        expect(stripHiddenText(`\u{1F3F4}${tags("gb-en")}${CANCEL}`).removed).toBe(6);
    });

    it("keeps a flag but strips a payload appended after it", () => {
        expect(stripHiddenText(`${FLAGS.wales}${tags("hi")}`)).toEqual({ removed: 2, text: FLAGS.wales });
    });

    it("counts every tag in the strict form, the flag's too", () => {
        expect(hasHiddenText(FLAGS.england, { strict: true })).toBe(true);
        expect(showHidden(FLAGS.england, { strict: true })).toBe("\u{1F3F4}??????");
    });
});

describe("findHiddenText", () => {
    it("reports UTF-16 offsets and lengths, an astral tag character being two units", () => {
        expect(findHiddenText("a\u{E0041}b\u{202E}")).toEqual([
            { index: 1, length: 2 },
            { index: 4, length: 1 },
        ]);
    });

    it("works where iterator helpers do not exist (Safari < 18.4, Chrome < 122, Firefox < 131)", () => {
        const prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())) as { map?: unknown; toArray?: unknown };
        const saved = { map: prototype.map, toArray: prototype.toArray };

        delete prototype.map;
        delete prototype.toArray;

        try {
            expect(findHiddenText("a\u{E0041}b")).toEqual([{ index: 1, length: 2 }]);
        } finally {
            prototype.map = saved.map;
            prototype.toArray = saved.toArray;
        }
    });
});
