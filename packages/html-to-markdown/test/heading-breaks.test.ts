import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * A hard break in a heading is written as a private-use mark that the built-in heading rule turns into a space.
 * The mark must never match text of the heading, never reach a custom heading rule, and never be confused with
 * text that looks like a break marker.
 */

// The private-use area, U+E000 to U+F8FF, read from escaped characters.
function convert(html: string, options = {}): string {
    return new TurndownService(options).turndown(html);
}

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

/*
 * A hard break inside a link in a heading. The heading writes its breaks as a private-use mark and turns it into a
 * space; the link must do the same, or a reference definition gets a label the heading's link no longer matches.
 */

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

/*
 * A break in a heading that holds a block is marked, so the heading can write it as a space. The mark must
 * move out of emphasis like any break, and a literal character of the same code point must stay in the text.
 */

describe("breaks in a heading that holds a block", () => {
    it("keeps a break inside emphasis outside the delimiters", () => {
        expect(convert("<h1><strong>a<br></strong><div>c</div></h1>", { br: "\n" })).toBe("**a**\n\nc\n========");
    });

    // With no break the heading text is written as is, as upstream does, so the underline spans the separators too.
    it("keeps a literal private-use character in the heading text", () => {
        expect(convert("<h1>leftright<div>c</div></h1>", { br: "\n" })).toBe(`leftright\n\nc\n\n\n${"=".repeat(15)}`);
    });
});

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

describe("a heading whose breaks a custom rule renders", () => {
    it("keeps the custom break output, since no break mark was written", () => {
        const service = new TurndownService({ headingStyle: "atx" });

        service.addRule("br", { filter: "br", replacement: () => "\n" });

        expect(service.turndown("<h1>a<br>b</h1>")).toBe("# a\nb");
        expect(service.turndown("<h1><br>a</h1>")).toBe("# \na");
    });
});

/*
 * Untrusted HTML can hold private-use text built to contain every candidate break mark: the candidates step through
 * the area by a fixed amount, so one run of about 6,400 characters in that progression holds them all. The search
 * must stop after a bounded number of candidates and fall back to a mark that is absent by construction.
 */

describe("a heading crafted to contain every candidate break mark", () => {
    it("still converts, and keeps its text", () => {
        let crafted = "";

        for (let index = 0; index < 6408; index += 1) {
            crafted += String.fromCodePoint(FIRST_PRIVATE_USE + ((index * 2329) % 6400));
        }

        const markdown = new TurndownService({ headingStyle: "atx" }).turndown(`<h1>${crafted}<br>b</h1>`);

        expect(markdown).toBe(`# ${crafted} b`);
    });
});
