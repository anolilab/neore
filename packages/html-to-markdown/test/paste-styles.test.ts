import { readFileSync } from "node:fs";

import { createDocument } from "@mixmark-io/domino";
import { describe, expect, it } from "vitest";

import TurndownService, { paste, PASTE_OPTIONS } from "../src/index";
import { appendCdataSection } from "./cdata";

/* eslint-disable no-secrets/no-secrets -- the cases are HTML with inline styles, whose entropy reads as a secret's */

/*
 * Formatting set by style and code blocks in the paste preset. The cases follow the composer's paste tests (apps/web,
 * composer-paste/paste-plan.test.ts). One difference in form: bold across a `<br>` is one span (`**one\ntwo**`), which
 * Markdown allows within a paragraph, where the composer marks each line.
 */

function convert(input: Node | string): string {
    return new TurndownService(PASTE_OPTIONS).use(paste).turndown(input);
}

function fixture(name: string): string {
    return readFileSync(new URL(`../bench/fixtures/${name}`, import.meta.url), "utf8");
}

describe("paste styles: formatting set by style", () => {
    it.each([
        ["a bold span", `<p><span style="font-weight:700">a</span> b</p>`, "**a** b"],
        ["an italic span", `<p><span style="font-style:italic">a</span> <span style="font-style:oblique 10deg">b</span></p>`, "*a* *b*"],
        [
            "a struck span, its tildes escaped",
            `<p><span style="text-decoration:line-through">a~b</span> <span style="text-decoration-line:underline line-through">c</span></p>`,
            String.raw`~~a\~b~~ ~~c~~`,
        ],
        ["a weight that is not bold", `<p><span style="font-weight:500">a</span></p>`, "a"],
    ])("writes %s", (_name, html, expected) => {
        expect(convert(html)).toBe(expected);
    });

    it("reads a style declared twice as CSS does", () => {
        expect(
            convert(
                `<p><span style="font-weight:bold; font-weight:normal">a</span></p><p><span style="font-weight:bold !important; font-weight:normal">b</span></p>`,
            ),
        ).toBe("a\n\n**b**");
    });

    it("marks the text of a styled paragraph, list item or table cell, not a heading's", () => {
        expect(
            convert(
                `<p style="font-weight:bold">Important</p><ul><li style="font-style:italic">item</li></ul><table><tr><th>A</th></tr><tr><td style="text-decoration:line-through">old</td></tr></table><h2 style="font-weight:bold">Title</h2>`,
            ),
        ).toBe("**Important**\n\n- *item*\n\n| A |\n| --- |\n| ~~old~~ |\n\n## Title");
    });

    it("leaves a styled block that holds a list without its own formatting, which cannot span the list", () => {
        expect(convert(`<div style="font-weight:bold"><ul><li>a</li></ul></div>`)).toBe("- a");
    });

    it("writes Google Docs' styled spans inside its list", () => {
        expect(convert(fixture("google-docs-list.html"))).toContain("- **Ship** the beta on Monday");
    });
});

describe("paste styles: text set back to normal weight inside bold", () => {
    it.each([
        ["a span", `<b>Bold <span style="font-weight:normal">normal</span> again</b>`, "**Bold** normal **again**"],
        ["a numeric weight inside a bold span", `<span style="font-weight:700">a<span style="font-weight:400">b</span>c</span>`, "**a**b**c**"],
        ["a normal-weight b", `<strong>one <b style="font-weight:normal">two</b></strong>`, "**one** two"],
        ["bold again inside it", `<b>a <span style="font-weight:normal">b <b>c</b> d</span> e</b>`, "**a** b **c** d **e**"],
        ["italic on the same span", `<b><span style="font-weight:400;font-style:italic">x</span></b>`, "*x*"],
        ["struck on the same span", `<b><span style="font-weight:400;text-decoration:line-through">x</span></b>`, "~~x~~"],
        ["inside italics in the bold", `<b><i><span style="font-weight:normal">x</span> y</i></b>`, "*x* ***y***"],
        ["with no bold around it", `<p>a <span style="font-weight:normal">b</span> <i>c</i></p>`, "a b *c*"],
    ])("stays out of the bold: %s", (_name, html, expected) => {
        expect(convert(html)).toBe(expected);
    });

    it("reads the control characters it marks runs with as no text, in a string or a node", () => {
        expect(convert("x\u{1}y<b>a\u{2}b</b>")).toBe("xy**ab**");
        expect(convert(createDocument(`<p><b>a<span style="font-weight:normal">b\u{1}</span></b></p>`).body)).toBe("**a**b");
    });
});

describe("paste styles: emoji sequences", () => {
    it.each([
        ["the first emoji bold", "<p><strong>👩</strong>\u{200D}👩 hi</p>", "👩\u{200D}👩 hi"],
        ["the last emoji italic", "<p>👩\u{200D}<em>👧</em></p>", "👩\u{200D}👧"],
        ["the joiner inside the bold", "<p><b>👩\u{200D}</b>👩</p>", "👩\u{200D}👩"],
        ["an emoji with its selector", `<p><span style="font-weight:bold">❤\u{FE0F}</span>\u{200D}🔥</p>`, "❤\u{FE0F}\u{200D}🔥"],
    ])("leaves formatting off part of a sequence, so the joiner stays beside its emoji: %s", (_name, html, expected) => {
        expect(convert(html)).toBe(expected);
    });

    it("still marks a whole emoji sequence or an emoji beside words", () => {
        expect(convert("<p><b>👩\u{200D}👩</b> and <b>🎉</b> <i>yay</i></p>")).toBe("**👩\u{200D}👩** and **🎉** *yay*");
    });
});

describe("paste styles: code blocks", () => {
    it("fences a bare pre and keeps its lines from <br> and line elements", () => {
        expect(convert("<pre>a<br>b</pre><pre><div>c</div><div>d</div></pre>")).toBe("```\na\nb\n```\n\n```\nc\nd\n```");
    });

    it("reads the language from the code, the block or the element around it", () => {
        expect(
            convert(
                `<pre class="language-js">x()</pre><pre><code class="lang-py">y</code></pre><div class="highlight highlight-source-shell"><pre>npm i</pre></div>`,
            ),
        ).toBe("```js\nx()\n```\n\n```py\ny\n```\n\n```shell\nnpm i\n```");
    });

    it("keeps the code block and the language of a GitHub README", () => {
        expect(convert(fixture("github-readme-table.html"))).toContain("```shell\nnpm install example\nnpx example --timeout 10\n```");
    });

    it("fences code holding a fence with a longer one", () => {
        const fence = "```";

        expect(convert(`<pre class="language-md">${fence}js\nx\n${fence}</pre>`)).toBe("````md\n```js\nx\n```\n````");
    });

    it("leaves out text the page hides inside a code block", () => {
        expect(convert(`<pre>x<span class="sr-only">HIDDEN</span><span style="display:none">H</span>y</pre>`)).toBe("```\nxy\n```");
    });

    it("writes a code block in a table cell as inline code, as the gfm rules do", () => {
        expect(convert(`<table><tr><th>A</th></tr><tr><td><pre class="language-js">x</pre></td></tr></table>`)).toBe("| A |\n| --- |\n| `x` |");
    });
});

describe("paste styles: output", () => {
    it("leaves out the blank text before the first content, such as the spaces in a pasted head", () => {
        expect(convert(fixture("word-paragraph.html"))).toBe("The quarterly numbers are in, and the trend holds.");
    });
});

describe("paste styles: review cases", () => {
    it("keeps a styled block's formatting when the list in it is hidden", () => {
        expect(convert(`<div style="font-weight:bold">a<ul style="display:none"><li>x</li></ul></div>`)).toBe("**a**");
    });

    it("formats each paragraph of styled text that holds blocks, as emphasis cannot span a blank line", () => {
        expect(convert(`<span style="font-weight:bold"><p>a</p><p>b</p></span>`)).toBe("**a**\n\n**b**");
        expect(convert(`<b>a <span style="font-weight:normal">b<p>c</p>d</span> e</b>`)).toBe("**a** b\n\nc\n\nd **e**");
    });

    it("writes one pair of delimiters for formatting inside the same formatting", () => {
        expect(convert(`<p style="font-weight:bold"><a href="https://x.y/docs" style="font-weight:bold">Docs</a></p>`)).toBe("**[Docs](https://x.y/docs)**");
        expect(convert(`<span style="font-weight:bold"><b>x</b> y</span> <span style="font-style:italic"><i>x</i> y</span>`)).toBe("**x y** *x y*");
    });

    it("keeps the formatting inside a styled block that writes none, as it holds a table", () => {
        expect(convert(`<div style="font-weight:bold"><table><tr><td>t</td></tr></table><span><b>x</b></span></div>`)).toBe("| t |\n| --- |\n\n**x**");
    });

    it("reads the CDATA in a code block passed as a node", () => {
        // Text before it: domino's textContent skips CDATA, so a block of CDATA alone would read as blank there.
        const document = createDocument("<pre><code>let </code></pre>");

        appendCdataSection(document.querySelector("code") as Element, "x = 1;");

        expect(convert(document.body)).toBe("```\nlet x = 1;\n```");
    });

    it("keeps a blank line an editor writes in code as a line with only a <br>", () => {
        expect(convert("<pre><div>one</div><div><br></div><div>three</div></pre>")).toBe("```\none\n\nthree\n```");
    });
});

describe("paste styles: review cases, second round", () => {
    it("takes the language from code the page shows, not from hidden code", () => {
        expect(convert(`<pre><code class="language-py" hidden>x</code><code class="language-js">y()</code></pre>`)).toBe("```js\ny()\n```");
        expect(convert(`<pre><span style="display:none"><code class="language-py">x</code></span><code class="language-js">y()</code></pre>`)).toBe(
            "```js\ny()\n```",
        );
    });

    it("keeps a blank line a code block ends with, dropping only the break that ends its last line", () => {
        expect(convert("<pre>a\n\n</pre>")).toBe("```\na\n\n```");
    });

    it("keeps italics set back to normal weight inside bold out of the bold", () => {
        expect(convert(`<b>a <i style="font-weight:normal">b</i> <em style="font-weight:400">c</em> d</b>`)).toBe("**a** *b* *c* **d**");
    });

    it("reads no joiner from hidden text beside an emoji, so the emoji keeps its formatting", () => {
        expect(convert(`<p><span style="display:none">\u{200D}</span><b>🎉</b></p>`)).toBe("**🎉**");
        expect(convert(`<p><b>🎉</b><span hidden>\u{200D}</span></p>`)).toBe("**🎉**");
    });
});

describe("paste styles: review cases, third round", () => {
    it("leaves medium weight inside bold out of the bold, as 500 is not bold", () => {
        expect(convert(`<b>a<span style="font-weight:500">b</span>c</b>`)).toBe("**a**b**c**");
    });

    it("puts headings, quotes and list items inside a code block on lines of their own", () => {
        expect(convert("<pre><h1>one</h1><h2>two</h2><blockquote>q</blockquote><ul><li>i</li><li>j</li></ul></pre>")).toBe("```\none\ntwo\nq\ni\nj\n```");
    });

    it("reads a decoration whose keywords a tab parts", () => {
        expect(convert(`<p><span style="text-decoration:line-through\tunderline">x</span></p>`)).toBe("~~x~~");
    });

    it("reads oblique as italic only alone or with an angle, as a browser does", () => {
        expect(
            convert(
                `<p><span style="font-style:obliquefoo">a</span> <span style="font-style:oblique 10deg">b</span> <span style="font-style:oblique">c</span> <span style="font-style:oblique 10px">d</span></p>`,
            ),
        ).toBe("a *b* *c* d");
    });
});

describe("paste styles: review cases, fourth round", () => {
    it("lets an invalid declaration override no earlier one, as a browser drops it", () => {
        expect(
            convert(
                `<p><span style="font-weight:bold; font-weight:bogus">x</span> <span style="font-style:italic; font-style:bogus">y</span> <span style="text-decoration-line:line-through; text-decoration-line:bogus">z</span></p>`,
            ),
        ).toBe("**x** *y* ~~z~~");
    });

    it("finds a joiner beside the inline element around formatting on part of an emoji sequence", () => {
        expect(convert("<p><span><b>👩</b></span>\u{200D}👩</p>")).toBe("👩\u{200D}👩");
        expect(convert("<p>👩\u{200D}<span><i>👧</i></span></p>")).toBe("👩\u{200D}👧");
    });

    it("keeps a normal-weight link inside bold out of the bold, its marks outside the link syntax", () => {
        expect(convert(`<b>a <a href="https://x.y" style="font-weight:normal">x</a> b</b>`)).toBe("**a** [x](https://x.y) **b**");
    });
});
