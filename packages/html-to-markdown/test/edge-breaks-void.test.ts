import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * A void element that prints nothing (a word-break hint, a form input) sits beside a hard break at the edge of an
 * element with flanking whitespace. It writes no Markdown, so the break must be kept as if it were not there.
 */

function trimLines(markdown: string): string {
    return markdown
        .split("\n")
        .map((line) => line.trim())
        .join("\n");
}

describe("a hard break beside a void element that prints nothing", () => {
    it.each([
        ["a leading word-break hint", "x<span> <wbr><br>foo</span>y", "x<span> <br>foo</span>y"],
        ["a leading input", "x<span> <input><br>foo</span>y", "x<span> <br>foo</span>y"],
        ["a trailing word-break hint", "x<span>foo<br><wbr> </span>y", "x<span>foo<br> </span>y"],
    ])("keeps the break with %s", (_name, html, without) => {
        const markdown = new TurndownService().turndown(html);

        // The space beside the void element may stay next to the break; it renders the same either way, since
        // extra trailing spaces still make a hard break and a leading space on the next line is dropped.
        expect(markdown).toContain("  \n");
        expect(trimLines(markdown)).toBe(trimLines(new TurndownService().turndown(without)));
    });

    it("still treats an image with a source as output", () => {
        expect(new TurndownService().turndown("x<span> <img src=a.png><br>foo</span>y")).toContain("![](a.png)");
    });
});
