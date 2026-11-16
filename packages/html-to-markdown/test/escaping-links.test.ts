import { describe, expect, it } from "vitest";

import type { Options } from "../src/index";
import TurndownService from "../src/index";
import { escapeMarkdown } from "../src/utilities";

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

    it("writes a backslash before an opening parenthesis the same way with safeLinks, which doubles every backslash", () => {
        // Both modes write the same Markdown, which CommonMark unescapes to the raw destination `a\(b`.
        expect(convert(String.raw`<a href="a\(b">x</a>`, { safeLinks: true })).toBe(convert(String.raw`<a href="a\(b">x</a>`));
        expect(convert(String.raw`<a href="a\(b">x</a>`, { safeLinks: true })).toBe(String.raw`[x](a\\\(b)`);
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

    it("escapes a parenthesis after a number that ends the paragraph, which would otherwise be an empty list", () => {
        expect(convert("<p>1)</p>")).toBe(String.raw`1\)`);
    });

    it("escapes a period after a number that ends the paragraph, which would otherwise be an empty list", () => {
        expect(convert("<p>1.</p>")).toBe(String.raw`1\.`);
    });

    it("escapes a multi-digit number that ends the paragraph", () => {
        expect(convert("<p>12)</p>")).toBe(String.raw`12\)`);
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

    it("escapes a less-than sign that ends a text node, since the next node may start with a letter", () => {
        expect(convert("<p>&lt;<span>b&gt;</span></p>")).toBe(String.raw`\<b>`);
    });

    it("escapes a less-than sign before an element that starts with a letter, past a blank element", () => {
        expect(convert("<p>&lt;<span></span>b&gt;</p>")).toBe(String.raw`\<b>`);
    });

    it("keeps a less-than sign that ends a paragraph, since nothing follows it", () => {
        expect(convert("<p>a &lt;</p>")).toBe("a <");
    });

    it("keeps a less-than sign before a block, since a line break follows it", () => {
        expect(convert("<p>a &lt;</p><p>b</p>")).toBe("a <\n\nb");
    });

    it("keeps a less-than sign followed by a space", () => {
        expect(convert("<p>1 &lt; 2</p>")).toBe("1 < 2");
    });

    it("keeps a less-than sign followed by a digit or an equals sign", () => {
        expect(convert("<p>&lt;1&gt; &lt;= 3</p>")).toBe("<1> <= 3");
    });

    it("escapes a less-than sign that ends an <a> without href, since its text prints with no brackets", () => {
        expect(convert("<p><a>&lt;</a>b&gt;</p>")).toBe(String.raw`\<b>`);
    });

    it("escapes a less-than sign that ends an <a> with an empty href, since its text prints with no brackets", () => {
        expect(convert(`<p><a href="">&lt;</a>script&gt;</p>`)).toBe(String.raw`\<script>`);
    });

    it("escapes a less-than sign that ends an <a> without href in reference-style links", () => {
        expect(convert("<p><a>&lt;</a>b&gt;</p>", { linkStyle: "referenced" })).toBe(String.raw`\<b>`);
    });

    it("escapes a less-than sign that ends an <a> with an empty href in reference-style links", () => {
        expect(convert(`<p><a href="">&lt;</a>script&gt;</p>`, { linkStyle: "referenced" })).toBe(String.raw`\<script>`);
    });

    it("keeps a less-than sign that ends a link, since the link's closing bracket follows it", () => {
        expect(convert(`<p><a href="x">&lt;</a>b&gt;</p>`)).toBe("[<](x)b>");
    });

    it("keeps a less-than sign that ends a reference-style link, since the link's closing bracket follows it", () => {
        expect(convert(`<p><a href="x">&lt;</a>b&gt;</p>`, { linkStyle: "referenced" })).toBe("[<][1]b>\n\n[1]: x");
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

    it("guard, passes before and after: a blank line in text becomes a space", () => {
        expect(convert(`<a href="/x">one\n\ntwo</a>`)).toBe("[one two](/x)");
    });

    it("guard, passes before and after: a hard line break inside a link is kept", () => {
        expect(convert(`<a href="/x">one<br>two</a>`)).toBe("[one  \ntwo](/x)");
    });

    it("keeps a list inside a link on one line, so no item marker starts a line", () => {
        expect(convert(`<a href="/x"><ul><li>a</li><li>b</li></ul></a>`)).toBe("[ *   a *   b ](/x)");
    });

    it("keeps a blockquote inside a link on one line, so no quote marker starts a line", () => {
        expect(convert(`<a href="/x"><blockquote><p>a</p><p>b</p></blockquote></a>`)).toBe("[ > a > > b ](/x)");
    });

    it("keeps a blockquote inside a reference-style link on one line", () => {
        expect(convert(`<a href="/x"><blockquote><p>a</p><p>b</p></blockquote></a>`, { linkStyle: "referenced" })).toBe("[ > a > > b ][1]\n\n[1]: /x");
    });

    it("keeps an ordered list that starts at zero on one line, so its second number cannot start a line", () => {
        expect(convert(`<a href="/x"><ol start="0"><li>a</li><li>b</li></ol></a>`)).toBe("[ 0.  a 1.  b ](/x)");
    });

    it("keeps a setext heading inside a link on one line, so its underline cannot start a line", () => {
        expect(convert(`<a href="/x"><h1>a</h1></a>`)).toBe("[ a = ](/x)");
    });

    it("does not start a line with a list item that follows a hard break", () => {
        expect(convert(`<a href="/x">one<br><li>x</li></a>`)).toBe("[one  *   x](/x)");
    });

    it("guard, passes before and after: a hard break whose next line is plain text is kept", () => {
        expect(convert(`<a href="/x">one<br>2019 report</a>`)).toBe("[one  \n2019 report](/x)");
    });

    it("guard, passes before and after: a hard break before bold text is kept, since ** starts no block", () => {
        expect(convert(`<a href="/x">one<br><b>two</b></a>`)).toBe("[one  \n**two**](/x)");
    });

    it("keeps a hard break before a lone plus sign, which cannot be a list item before the closing bracket", () => {
        expect(convert(`<a href="/x">one<br>+</a>`)).toBe("[one  \n+](/x)");
    });

    it("guard, passes before and after: a hard break before an escaped plus list marker is kept", () => {
        expect(convert(`<a href="/x">one<br>+ x</a>`)).toBe("[one  \n\\+ x](/x)");
    });
});

describe("review: custom hard breaks in link text", () => {
    it("keeps a configured break that is a space then a backslash, so the link keeps its line break", () => {
        expect(convert(`<a href="/x">one<br>two</a>`, { br: " \\" })).toBe("[one \\\ntwo](/x)");
    });

    it("keeps a configured break of two spaces, the default form", () => {
        expect(convert(`<a href="/x">one<br>two</a>`, { br: "  " })).toBe("[one  \ntwo](/x)");
    });
});

describe("review: inline tags after a hard break in link text", () => {
    it("keeps a hard break before a kept inline tag, which cannot interrupt a paragraph", () => {
        const service = new TurndownService();

        service.keep(["span"]);

        expect(service.turndown(`<a href="/x">one<br><span class="s">two</span></a>`)).toBe(`[one  \n<span class="s">two</span>](/x)`);
    });

    it("keeps a hard break before an emphasis tag", () => {
        expect(convert(`<a href="/x">one<br><em>two</em></a>`)).toBe("[one  \n_two_](/x)");
    });

    it("guard, passes before and after: a hard break before a block tag is still replaced, as a block starts a line", () => {
        expect(convert(`<a href="/x">one<br><div>two</div></a>`)).toBe("[one  two ](/x)");
    });
});

describe("review: ordered-list lookalikes followed by a tab or a line end", () => {
    it("escapes a closing parenthesis after a leading number when a tab follows, which CommonMark reads as a list item", () => {
        expect(escapeMarkdown("1)\titem")).toBe("1\\)\titem");
    });

    it("escapes a period after a leading number when a tab follows", () => {
        expect(escapeMarkdown("2.\titem")).toBe("2\\.\titem");
    });

    it("escapes a number that ends a line, which is an empty list item", () => {
        expect(escapeMarkdown("3.\nitem")).toBe("3\\.\nitem");
    });

    it("guard, passes before and after: a number followed by a letter is not a list item", () => {
        expect(escapeMarkdown("1)item")).toBe("1)item");
    });
});

describe("review: indented lines after a hard break in link text", () => {
    function indentedSpan(indent: string): TurndownService {
        const service = new TurndownService();

        service.addRule("indentedSpan", { filter: "span", replacement: () => `${indent}- text` });

        return service;
    }

    it("keeps a hard break before a line indented four spaces, which is a continuation and not a list item", () => {
        expect(indentedSpan(" ".repeat(4)).turndown(`<a href="/x">one<br><span>x</span></a>`)).toBe("[one  \n    - text](/x)");
    });

    it("guard, passes before and after: a hard break before a line indented three spaces still ends the line for a list item", () => {
        expect(indentedSpan(" ".repeat(3)).turndown(`<a href="/x">one<br><span>x</span></a>`)).not.toContain("one  \n");
    });
});

describe("review: formatted text after a hard break in link text", () => {
    it("keeps a hard break before text that starts with three emphasis markers, which is not a thematic break", () => {
        expect(convert(`<a href="/x">one<br><strong><em>text</em></strong></a>`, { emDelimiter: "*" })).toBe("[one  \n***text***](/x)");
    });

    it("guard, passes before and after: a hard break before a real thematic break is still replaced", () => {
        expect(convert(`<a href="/x">one<br><hr>two</a>`)).toBe("[one  * * * two](/x)");
    });
});

describe("review: reference labels that two links share", () => {
    it("gives a second collapsed link its own id when its label names another destination", () => {
        expect(convert(`<a href="/a">one</a> <a href="/b">one</a>`, { linkReferenceStyle: "collapsed", linkStyle: "referenced" })).toBe(
            "[one][] [one][2]\n\n[one]: /a\n[2]: /b",
        );
    });

    it("treats labels that differ only in case as the same label, so a shortcut link gets its own id", () => {
        expect(convert(`<a href="/a">one</a> <a href="/b">One</a>`, { linkReferenceStyle: "shortcut", linkStyle: "referenced" })).toBe(
            "[one] [One][2]\n\n[one]: /a\n[2]: /b",
        );
    });

    // CommonMark matches labels after Unicode case folding, so `ß` and `SS` are one label.
    it.each(["collapsed", "shortcut"] as const)("treats labels that are equal after case folding as one label in %s style", (linkReferenceStyle) => {
        const markdown = convert(`<a href="/a">ß</a> <a href="/b">SS</a>`, { linkReferenceStyle, linkStyle: "referenced" });

        expect(markdown).toContain("[SS][2]");
        expect(markdown).toContain("[2]: /b");
    });

    it("guard, passes before and after: two links to one destination under one label share one label", () => {
        expect(convert(`<a href="/a">one</a> <a href="/a">one</a>`, { linkReferenceStyle: "collapsed", linkStyle: "referenced" })).toBe(
            "[one][] [one][]\n\n[one]: /a\n[one]: /a",
        );
    });
});

describe("review: email addresses in angle brackets", () => {
    it("escapes a < before an email address that starts with a digit, so it is not an autolink", () => {
        expect(convert("&lt;1a@b.co&gt;")).toBe(String.raw`\<1a@b.co>`);
    });

    it("escapes a < at the end of a text node when the next text starts with an email address", () => {
        expect(convert("&lt;<span>1a@b.co&gt;</span>")).toBe(String.raw`\<1a@b.co>`);
    });

    it("guard, passes before and after: a < between spaces is not escaped", () => {
        expect(convert("1 &lt; 2")).toBe("1 < 2");
    });

    it.each([
        ["a digit", "&lt;1<span>a@b.co&gt;</span>", String.raw`\<1a@b.co>`],
        ["a digit and a dot", "&lt;1.x<span>a@b.co&gt;</span>", String.raw`\<1.xa@b.co>`],
    ])("escapes a < when the local part after it starts with %s and its @ is in the next node", (_name, html, expected) => {
        expect(convert(html)).toBe(expected);
    });

    it("escapes a < before a letter once when the local part's @ is in the next node", () => {
        expect(convert("&lt;a<span>b@c.co&gt;</span>")).toBe(String.raw`\<ab@c.co>`);
    });

    it("guard: a < before a split local part with no @ after it is not escaped", () => {
        expect(convert("x &lt;1<span>2</span>")).toBe("x <12");
        expect(convert("&lt;1<span>a b@c&gt;</span>")).toBe("<1a b@c>");
    });

    it("guard, passes before and after: a < before a digit with no @ after it is not escaped", () => {
        expect(convert("a&lt;1")).toBe("a<1");
    });
});

describe("review: backslashes before a hyphen in a destination", () => {
    it("escapes a backslash before a hyphen, which is ASCII punctuation that CommonMark would unescape", () => {
        expect(convert(String.raw`<a href="a\-b">x</a>`)).toBe(String.raw`[x](a\\-b)`);
    });

    it("guard, passes before and after: a backslash before a letter is still left alone", () => {
        expect(convert(String.raw`<a href="a\c-d">x</a>`)).toBe(String.raw`[x](a\c-d)`);
    });
});

describe("review: a backslash hard break in link text", () => {
    function blockStartingSpan(): TurndownService {
        const service = new TurndownService({ br: "\\" });

        service.addRule("blockStartingSpan", { filter: "span", replacement: () => "- x" });

        return service;
    }

    it("drops a backslash break that is not kept, so no stray backslash shows in the link text", () => {
        expect(blockStartingSpan().turndown(`<a href="/x">one<br><span>x</span></a>`)).toBe("[one - x](/x)");
    });

    it("guard, passes before and after: a space break that is not kept still leaves the spaces it always left", () => {
        const service = new TurndownService();

        service.addRule("blockStartingSpan", { filter: "span", replacement: () => "- x" });

        expect(service.turndown(`<a href="/x">one<br><span>x</span></a>`)).toBe("[one  - x](/x)");
    });
});

describe("review: turning escaping off", () => {
    it("escapes a < before text that is an HTML opener by default", () => {
        expect(convert("<p>a&lt;<span>b</span></p>")).toBe(String.raw`a\<b`);
    });

    it("writes no backslash when a custom escape is a no-op, so the output holds only the text", () => {
        const service = new TurndownService();

        service.escape = (text: string) => text;

        expect(service.turndown("<p>a&lt;<span>b</span></p>")).toBe("a<b");
    });
});

/*
 * Flattening link text replaces only line breaks and their ASCII indentation. Text before a break that looks like a
 * custom marker is the link's own text, and a non-breaking space after a break is content, so both stay.
 */

describe("link text around a flattened line break", () => {
    it.each([
        ["an inline link", {}, "[ aX b ](/x)"],
        ["a reference link", { linkStyle: "referenced" as const }, "[ aX b ][1]\n\n[1]: /x"],
    ])("keeps literal text that matches a custom marker in %s", (_name, options, expected) => {
        expect(convert("<a href=/x><p>aX</p><p>b</p></a>", { br: "X", ...options }).trim()).toBe(expected);
    });

    it.each([
        ["a newline marker", "\n", "[a b](/x)"],
        ["a marker that ends in a newline", "X\n", "[aX b](/x)"],
    ])("flattens %s that is not kept, so no newline stays in the link text", (_name, br, expected) => {
        expect(convert("<a href=/x>a<br>b</a>", { br })).toBe(expected);
        expect(convert("<a href=/x>a<br><h1>b</h1></a>", { br })).not.toContain("\n");
    });

    it("keeps an inline-tag marker, which is valid in link text, and flattens only the line break", () => {
        expect(convert("<a href=/x>a<br>b</a>", { br: "<br>" })).toBe("[a<br> b](/x)");
    });

    it("guard: drops a backslash marker that is not kept, which would show as a backslash", () => {
        expect(convert("<a href=/x>a<br><h1>b</h1></a>", { br: "\\" })).not.toContain("a\\");
    });

    it("keeps non-breaking spaces after a paragraph break", () => {
        expect(convert("<a href=/x><p>one</p><p>&nbsp;&nbsp;two</p></a>")).toBe("[ one \u{A0}\u{A0}two ](/x)");
    });

    it("keeps a hard break before a non-breaking space, which cannot open a list", () => {
        expect(convert("<a href=/x>a<br>&nbsp;- b</a>")).toBe("[a  \n\u{A0}- b](/x)");
    });
});

/*
 * Under safeLinks an unsafe link prints only its text, with no brackets around it. A `<` at the end of that text is
 * then followed directly by what comes after the link, so the look-ahead reads on past it.
 */

describe("a < at the end of an unsafe link's text under safeLinks", () => {
    it.each([
        ["an element", `<a href="javascript:x">a&lt;</a><span>img src=x onerror=alert(1)&gt;</span>`, String.raw`a\<img src=x onerror=alert(1)>`],
        ["a letter", `<a href="javascript:x">a&lt;</a>b`, String.raw`a\<b`],
    ])("escapes the < when %s follows the link", (_name, html, expected) => {
        expect(convert(html, { safeLinks: true })).toBe(expected);
    });

    it("guard: a < inside a rendered link is closed off by the bracket", () => {
        expect(convert(`<a href="/ok">a&lt;</a>b`, { safeLinks: true })).toBe("[a<](/ok)b");
    });
});

/*
 * CommonMark collapses only spaces, tabs and line endings in a reference label. A non-breaking space is part of the
 * label, so `a&nbsp;b` and `a b` are two labels and both keep the collapsed style.
 */

describe("reference labels with a non-breaking space", () => {
    it("treats a label with a non-breaking space as distinct from one with a space", () => {
        expect(convert(`<a href="/a">a&nbsp;b</a> <a href="/b">a b</a>`, { linkReferenceStyle: "collapsed", linkStyle: "referenced" })).toBe(
            "[a\u{A0}b][] [a b][]\n\n[a\u{A0}b]: /a\n[a b]: /b",
        );
    });
});

/*
 * Deciding whether a dropped marker ends in a hard break reads back from the marker only, so a link with many breaks
 * stays linear (24,000 such breaks took about 8 s when the whole text before each was read). The time is not asserted,
 * since a busy runner could fail any fixed limit; this pins the output of the flattened breaks.
 */

describe("a link with several breaks that are not kept", () => {
    it("flattens each break and keeps an inline-tag marker", () => {
        expect(convert(`<a href=/x>${"a<br><h1>b</h1>".repeat(2)}</a>`, { br: "<br>" })).toBe("[a<br> b = a<br> b = ](/x)");
    });
});

/*
 * A removed element prints nothing, so the look-ahead after a `<` skips it and reads what follows it.
 */

describe("a < before a removed element", () => {
    it.each([
        ["a sibling", "a&lt;<span>=</span>div&gt;", String.raw`a\<div>`],
        ["inside an inline parent", "a&lt;<b><span>=</span>div&gt;</b>", String.raw`a\<**div>**`],
    ])("escapes the < when the removed element is %s and a tag name follows it", (_name, html, expected) => {
        const service = new TurndownService();

        service.remove("span");

        expect(service.turndown(html)).toBe(expected);
    });
});
