import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * A heading with many breaks and a block. Every break asks for its heading's break mark, which is computed once per
 * heading. These tests check the output only; a wall-clock limit would fail on a busy runner while the output is right.
 */

describe("a heading with many breaks and a block", () => {
    it("converts 8,000 breaks to one line of words and the block", () => {
        const markdown = new TurndownService({ br: "\n", headingStyle: "atx" }).turndown(`<h1>${"a<br>".repeat(8000)}<div>c</div></h1>`);

        expect(markdown).toBe(`# ${"a ".repeat(7999)}a\n\nc`);
    });

    it("keeps every word of a long heading, in order", () => {
        const words = Array.from({ length: 2000 }, (_value, index) => `w${index}`);
        const markdown = new TurndownService({ br: "\n", headingStyle: "atx" }).turndown(`<h1>${words.map((word) => `${word}<br>`).join("")}<div>c</div></h1>`);

        expect(markdown).toBe(`# ${words.join(" ")}\n\nc`);
    });
});
