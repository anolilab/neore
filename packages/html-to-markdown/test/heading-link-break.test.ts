import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * A hard break inside a link in a heading. The heading writes its breaks as a private-use mark and turns it into a
 * space; the link must do the same, or a reference definition gets a label the heading's link no longer matches.
 */

const FIRST = "\u{E000}".codePointAt(0) ?? 0;
const LAST = "\u{F8FF}".codePointAt(0) ?? 0;

function hasPrivateUse(text: string): boolean {
    return [...text].some((character) => {
        const code = character.codePointAt(0) ?? 0;

        return code >= FIRST && code <= LAST;
    });
}

describe("a link with a break inside a heading", () => {
    it.each(["collapsed", "shortcut"] as const)("keeps the %s reference label and its definition the same", (linkReferenceStyle) => {
        const markdown = new TurndownService({ headingStyle: "atx", linkReferenceStyle, linkStyle: "referenced" }).turndown("<h1><a href=/u>a<br>b</a></h1>");

        expect(hasPrivateUse(markdown)).toBe(false);
        expect(markdown).toContain("[a b]");
        expect(markdown).toContain("[a b]: /u");
    });

    it("writes an inlined link's text with a space for the break", () => {
        const markdown = new TurndownService({ headingStyle: "atx" }).turndown("<h1><a href=/u>a<br>b</a></h1>");

        expect(markdown).toBe("# [a b](/u)");
    });
});
