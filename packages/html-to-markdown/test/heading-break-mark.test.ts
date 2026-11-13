import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * A hard break in a heading is written as a private-use mark that the built-in heading rule turns into a space.
 * The mark must never match text of the heading, never reach a custom heading rule, and never be confused with
 * text that looks like a break marker.
 */

// The private-use area, U+E000 to U+F8FF, read from escaped characters.
const FIRST_PRIVATE_USE = "\u{E000}".codePointAt(0) ?? 0;
const LAST_PRIVATE_USE = "\u{F8FF}".codePointAt(0) ?? 0;

function hasPrivateUse(text: string): boolean {
    return [...text].some((character) => {
        const code = character.codePointAt(0) ?? 0;

        return code >= FIRST_PRIVATE_USE && code <= LAST_PRIVATE_USE;
    });
}

function allPrivateUse(): string {
    let text = "";

    for (let code = FIRST_PRIVATE_USE; code <= LAST_PRIVATE_USE; code += 1) {
        text += String.fromCodePoint(code);
    }

    return text;
}

describe("the break mark in a heading", () => {
    it("keeps literal private-use text when the heading holds every private-use character", () => {
        const literal = allPrivateUse();
        const markdown = new TurndownService({ br: "\n", headingStyle: "atx" }).turndown(`<h1>${literal}<br>b<div>c</div></h1>`);

        expect(markdown).toBe(`# ${literal} b\n\nc`);
    });

    // The mark is chosen from the markup, but a custom rule's output is not markup; it must not be taken for a break.
    it("keeps a private-use character that a custom rule writes inside a heading with a break", () => {
        const service = new TurndownService({ headingStyle: "atx" });

        service.addRule("span", { filter: "span", replacement: () => String.fromCodePoint(FIRST_PRIVATE_USE) });

        expect(service.turndown("<h1>x<span>s</span><br>y</h1>")).toBe(`# x${String.fromCodePoint(FIRST_PRIVATE_USE)} y`);
    });

    it("gives a custom heading rule the break marker, not the mark", () => {
        const service = new TurndownService({ br: "\n" });

        service.addRule("custom-heading", { filter: "h1", replacement: (content: string) => `[${content}]` });

        const markdown = service.turndown("<h1>a<br>b<div>c</div></h1>");

        expect(hasPrivateUse(markdown)).toBe(false);
        expect(markdown).toContain("a\n\nb");
    });

    it("keeps the line endings of a code block in a heading that holds a break", () => {
        const markdown = new TurndownService({ codeBlockStyle: "fenced", headingStyle: "atx" }).turndown("<h1>a<br>b<pre><code>x  \ny</code></pre></h1>");

        expect(markdown).toContain("```\nx  \ny\n```");
        expect(markdown.startsWith("# a b")).toBe(true);
    });
});
