import { describe, expect, it } from "vitest";

import { hasHiddenText, showHidden } from "./hidden-text";

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
