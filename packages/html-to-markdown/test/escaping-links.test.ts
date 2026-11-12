import { describe, expect, it } from "vitest";

import type { Options } from "../src/index";
import TurndownService from "../src/index";

function convert(html: string, options: Partial<Options> = {}): string {
    return new TurndownService(options).turndown(html);
}

describe("link destinations", () => {
    it("escapes a backslash before a parenthesis so the link does not close early (#546)", () => {
        expect(convert(String.raw`<a href="a\)b">x</a>`)).toBe(String.raw`[x](a\\\)b)`);
    });

    it("escapes a backslash before an opening parenthesis", () => {
        expect(convert(String.raw`<a href="a\(b">x</a>`)).toBe(String.raw`[x](a\\\(b)`);
    });

    it("escapes a trailing backslash, which would otherwise escape the closing parenthesis", () => {
        expect(convert(String.raw`<a href="a\">x</a>`)).toBe(String.raw`[x](a\\)`);
    });

    it("keeps the wrapped form when a trailing backslash sits beside a space", () => {
        expect(convert(String.raw`<a href="a b\">x</a>`)).toBe(String.raw`[x](<a b\\>)`);
    });

    it("leaves a backslash before a letter unchanged", () => {
        expect(convert(String.raw`<a href="a\b">x</a>`)).toBe(String.raw`[x](a\b)`);
    });

    it("applies the same destination rule to images", () => {
        expect(convert(String.raw`<img src="a\)b.png" alt="">`)).toBe(String.raw`![](a\\\)b.png)`);
    });
});

describe("text that looks like an ordered list", () => {
    it("escapes the parenthesis after a leading number (#531)", () => {
        expect(convert("<p>1) not a list</p>")).toBe(String.raw`1\) not a list`);
    });

    it("escapes a multi-digit number followed by a parenthesis", () => {
        expect(convert("<p>12) twelve</p>")).toBe(String.raw`12\) twelve`);
    });

    it("keeps the existing escape for a period", () => {
        expect(convert("<p>1. not a list</p>")).toBe(String.raw`1\. not a list`);
    });

    it("does not escape a parenthesis that is not followed by a space", () => {
        expect(convert("<p>1)not a list</p>")).toBe("1)not a list");
    });

    it("does not escape a parenthesis that is not at the start of a line", () => {
        expect(convert("<p>a 1) b</p>")).toBe("a 1) b");
    });
});

describe("text that could start raw HTML (#395, #106, #152)", () => {
    it("escapes the angle brackets of an element written as text", () => {
        expect(convert("<p>&lt;h1&gt;1. Hello&lt;/h1&gt;</p>")).toBe(String.raw`\<h1>1. Hello\</h1>`);
    });

    it("escapes a comment opener", () => {
        expect(convert("<p>&lt;!-- note --&gt;</p>")).toBe(String.raw`\<!-- note -->`);
    });

    it("escapes a processing instruction opener", () => {
        expect(convert("<p>&lt;?php echo 1 ?&gt;</p>")).toBe(String.raw`\<?php echo 1 ?>`);
    });

    it("escapes an autolink-shaped span, which a scheme letter would otherwise turn into a link", () => {
        expect(convert("<p>&lt;https://example.com&gt;</p>")).toBe(String.raw`\<https://example.com>`);
    });

    it("keeps a less-than sign followed by a space", () => {
        expect(convert("<p>1 &lt; 2</p>")).toBe("1 < 2");
    });

    it("keeps a less-than sign followed by a digit or an equals sign", () => {
        expect(convert("<p>&lt;1&gt; &lt;= 3</p>")).toBe("<1> <= 3");
    });
});

describe("block elements inside a link (#278, #409, #332)", () => {
    it("makes a heading inside a link a valid link", () => {
        expect(convert(`<a href="/foo"><h3>bar</h3></a>`)).toBe("[ ### bar ](/foo)");
    });

    it("makes a heading inside a reference-style link a valid link", () => {
        expect(convert(`<a href="/foo"><h3>bar</h3></a>`, { linkStyle: "referenced" })).toBe("[ ### bar ][1]\n\n[1]: /foo");
    });

    it("turns each blank line between paragraphs into a single space", () => {
        expect(convert(`<a href="/foo"><p>one</p><p>two</p></a>`)).toBe("[ one two ](/foo)");
    });

    it("turns a blank line in text into a single space", () => {
        expect(convert(`<a href="/x">one\n\ntwo</a>`)).toBe("[one two](/x)");
    });

    it("keeps a hard line break, which CommonMark allows inside link text", () => {
        expect(convert(`<a href="/x">one<br>two</a>`)).toBe("[one  \ntwo](/x)");
    });
});
