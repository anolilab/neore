import { describe, expect, it } from "vitest";

import { cutOnCodePoint } from "./execute";

const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/u;

describe("cutOnCodePoint", () => {
    it("keeps a short text as it is", () => {
        expect(cutOnCodePoint("hello", 2000)).toBe("hello");
    });

    it("never leaves half of an emoji at the cut", () => {
        // The emoji starts at unit 1999, so cutting at 2000 would keep only its high surrogate.
        const text = `${"x".repeat(1999)}\u{1F600}more`;
        const cut = cutOnCodePoint(text, 2000);

        expect(cut).toBe("x".repeat(1999));
        expect(TRAILING_HIGH_SURROGATE.test(cut)).toBe(false);
    });

    it("keeps a whole emoji that ends exactly at the cut", () => {
        const text = `${"x".repeat(1998)}\u{1F600}more`;

        expect(cutOnCodePoint(text, 2000)).toBe(`${"x".repeat(1998)}\u{1F600}`);
    });
});
