import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * A break in a heading that holds a block is marked, so the heading can write it as a space. The mark must
 * move out of emphasis like any break, and a literal character of the same code point must stay in the text.
 */

function convert(html: string, options = {}): string {
    return new TurndownService(options).turndown(html);
}

describe("breaks in a heading that holds a block (Qodo)", () => {
    it("keeps a break inside emphasis outside the delimiters", () => {
        expect(convert("<h1><strong>a<br></strong><div>c</div></h1>", { br: "\n" })).toBe("**a**\n\nc\n========");
    });

    // With no break the heading text is written as is, as upstream does, so the underline spans the separators too.
    it("keeps a literal private-use character in the heading text", () => {
        expect(convert("<h1>leftright<div>c</div></h1>", { br: "\n" })).toBe(`leftright\n\nc\n\n\n${"=".repeat(15)}`);
    });
});
