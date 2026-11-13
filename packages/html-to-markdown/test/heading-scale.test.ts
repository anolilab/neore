import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * Each break in a heading that holds a block asks for the heading's break mark. The mark is now computed once per
 * heading, and the marks are joined without rescanning the text written so far. The conversion is still not linear
 * (see the PR notes), so this checks the output of a long heading, not its speed.
 */

describe("a heading with many breaks and a block", () => {
    it("keeps the paragraph break after a long heading", () => {
        const markdown = new TurndownService({ br: "\n", headingStyle: "atx" }).turndown(`<h1>${"a<br>".repeat(2000)}<div>c</div></h1>`);

        expect(markdown.endsWith("\n\nc")).toBe(true);
        expect(markdown.startsWith("# a a ")).toBe(true);
    });
});
