import { describe, expect, it } from "vitest";

import type { Options } from "../src/index";
import TurndownService from "../src/index";
import { htmlOpenerSteps } from "../src/turndown";
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
        expect(convert(`<a href="/x">one<br><div>two</div></a>`)).not.toContain("one  \n");
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
        expect(convert(`<a href="/x">one<br><hr>two</a>`)).not.toContain("one  \n");
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

describe("review: deeply nested text after a <", () => {
    // Each level is a `<` text followed by a span that holds the next level. The count of nodes read
    // must grow in proportion to the depth: the walk reads each level's first text and stops there.
    const STEPS_PER_LEVEL = 20;

    function nestedLessThan(depth: number): string {
        let html = "x";

        for (let level = 0; level < depth; level += 1) {
            html = `<span>&lt;${html}</span>`;
        }

        return html;
    }

    it.each([250, 500])("reads the text after each < in a bounded number of steps at depth %i", (depth) => {
        htmlOpenerSteps.count = 0;

        const output = new TurndownService().turndown(nestedLessThan(depth));

        // The innermost `<` is followed by the letter `x`, which it would open raw HTML before, so it is escaped.
        expect(output).toBe(String.raw`${"<".repeat(depth - 1)}\<x`);
        expect(htmlOpenerSteps.count).toBeGreaterThanOrEqual(depth);
        expect(htmlOpenerSteps.count).toBeLessThan(STEPS_PER_LEVEL * depth);
    });
});
