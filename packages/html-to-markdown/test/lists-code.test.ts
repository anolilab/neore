import TurndownUpstream from "turndown";
import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * Lists and code blocks. Each block names the upstream issue it covers. Where the
 * expected output differs from upstream 7.2.5, the test says so.
 */

function convert(html: string, options = {}): string {
    return new TurndownService(options).turndown(html);
}

describe("ordered list start (#547)", () => {
    it.each([
        ["a non-numeric start is ignored", "abc", "1.  a\n2.  b"],
        ["a leading integer is read, the rest ignored", "3x", "3.  a\n4.  b"],
        ["a fraction is cut at the integer part", "3.7", "3.  a\n4.  b"],
        ["leading whitespace is skipped", " 4", "4.  a\n5.  b"],
        ["a whitespace-only start is ignored", " ", "1.  a\n2.  b"],
        ["an empty start is ignored", "", "1.  a\n2.  b"],
        ["a zero start is kept", "0", "0.  a\n1.  b"],
        ["a plain start is kept", "3", "3.  a\n4.  b"],
    ])("%s", (_name, start, expected) => {
        const markdown = convert(`<ol start="${start}"><li>a</li><li>b</li></ol>`);

        expect(markdown).toBe(expected);
        expect(markdown).not.toContain("NaN");
    });

    // A start beyond the safe integer range is written as its exact digits. Number() would print 1e+21 or Infinity.
    it.each([
        ["a start that formats in exponential notation", "1000000000000000000000", "1000000000000000000000.  a\n1000000000000000000001.  b"],
        ["a start that overflows to Infinity", "9".repeat(400), `${"9".repeat(400)}.  a\n1${"0".repeat(400)}.  b`],
        ["a start above 2^53 keeps its last digits", "9007199254740993", "9007199254740993.  a\n9007199254740994.  b"],
    ])("%s", (_name, start, expected) => {
        const markdown = convert(`<ol start="${start}"><li>a</li><li>b</li></ol>`);

        expect(markdown).toBe(expected);
        expect(markdown).not.toMatch(/e\+|Infinity|NaN/);
    });
});

describe("text after a nested list (#554)", () => {
    it("keeps the text inside the parent item, in its own paragraph", () => {
        const html = "<ul><li>Fruits<ul><li>Apple</li><li>Pear</li></ul>are healthy.</li><li>Next</li></ul>";

        expect(convert(html)).toBe("*   Fruits\n    *   Apple\n    *   Pear\n    \n    are healthy.\n*   Next");
    });

    it("does the same for an ordered parent and child", () => {
        const html = "<ol><li>Fruits<ol><li>Apple</li></ol>are healthy.</li><li>Next</li></ol>";

        expect(convert(html)).toBe("1.  Fruits\n    1.  Apple\n    \n    are healthy.\n2.  Next");
    });

    it("does not change a nested list that ends its item", () => {
        const html = "<ul><li>Fruits<ul><li>Apple</li><li>Pear</li></ul></li><li>Next</li></ul>";

        expect(convert(html)).toBe("*   Fruits\n    *   Apple\n    *   Pear\n*   Next");
    });

    it("adds one blank line, not two, when a loose item has text after a nested list", () => {
        const html = "<ul><li><p>Fruits</p><ul><li><p>Pear</p></li></ul>are healthy.</li></ul>";

        expect(convert(html)).toBe("*   Fruits\n    \n    *   Pear\n        \n    are healthy.");
    });

    it("does not change whitespace after a nested list", () => {
        const html = "<ul><li>Fruits<ul><li>Apple</li></ul> </li><li>Next</li></ul>";

        expect(convert(html)).toBe(new TurndownUpstream().turndown(html));
    });
});

describe("code block with whitespace or a wrapper before <code> (#486, #498, #530)", () => {
    it.each([
        ["whitespace before <code>", "<pre>   <code>x = 1</code></pre>"],
        ["a wrapper element around <code>", "<pre><div><code>x = 1</code></div></pre>"],
        ["whitespace inside a wrapper", "<pre><div>\n  <code>x = 1</code>\n</div></pre>"],
    ])("%s is a code block in indented style", (_name, html) => {
        expect(convert(html, { codeBlockStyle: "indented" })).toBe("    x = 1");
    });

    it.each([
        ["whitespace before <code>", "<pre>   <code>x = 1</code></pre>"],
        ["a wrapper element around <code>", "<pre><div><code>x = 1</code></div></pre>"],
    ])("%s is a fenced code block in fenced style", (_name, html) => {
        expect(convert(html, { codeBlockStyle: "fenced" })).toBe("```\nx = 1\n```");
    });

    it("keeps the code text of a multi-line block", () => {
        const html = "<pre>\n  <code class=language-js>a = 1\nb = 2</code>\n</pre>";

        expect(convert(html, { codeBlockStyle: "fenced" })).toBe("```js\na = 1\nb = 2\n```");
    });

    it.each(["indented", "fenced"])("a link around <code> keeps the link in %s style", (codeBlockStyle) => {
        const html = "<pre><a href=u><code>x</code></a></pre>";

        expect(convert(html, { codeBlockStyle })).toBe("[`x`](u)");
    });

    it.each([
        ["bold", "<pre><b><code>x</code></b></pre>", "**`x`**"],
        ["emphasis", "<pre><em><code>x</code></em></pre>", "_`x`_"],
        ["paragraph", "<pre><p><code>x</code></p></pre>", "`x`"],
    ])("a %s element around <code> matches upstream in both styles", (_name, html, expected) => {
        for (const codeBlockStyle of ["indented", "fenced"] as const) {
            expect(convert(html, { codeBlockStyle })).toBe(expected);
            expect(new TurndownUpstream({ codeBlockStyle }).turndown(html)).toBe(expected);
        }
    });

    // Upstream 7.2.5 only makes a code block when the first child of <pre> is <code>, so it
    // gives inline code here. The port treats a span as a wrapper (WRAPPER_ELEMENTS). The
    // expected output is the port's, and the upstream output is pinned to show the difference.
    it.each([
        ["indented", "    x"],
        ["fenced", "```\nx\n```"],
    ])("a span around <code> makes a code block in %s style, unlike upstream", (codeBlockStyle, expected) => {
        const html = "<pre><span><code>x</code></span></pre>";

        expect(convert(html, { codeBlockStyle })).toBe(expected);
        expect(new TurndownUpstream({ codeBlockStyle }).turndown(html)).toBe("`x`");
    });

    it("does not make a code block when text comes before <code>", () => {
        const html = "<pre>note <code>x = 1</code></pre>";
        const upstream = new TurndownUpstream({ codeBlockStyle: "indented" }).turndown(html);

        expect(convert(html, { codeBlockStyle: "indented" })).toBe(upstream);
    });
});

describe("ordinary pre and code output is unchanged", () => {
    it.each([
        ["plain", "<pre><code>x = 1</code></pre>"],
        ["with a language", "<pre><code class=language-js>x = 1\ny = 2</code></pre>"],
        ["with a trailing newline", "<pre><code>x = 1\n</code></pre>"],
    ])("%s", (_name, html) => {
        for (const codeBlockStyle of ["indented", "fenced"]) {
            const upstream = new TurndownUpstream({ codeBlockStyle }).turndown(html);

            expect(convert(html, { codeBlockStyle })).toBe(upstream);
        }
    });

    it("keeps the indented form", () => {
        expect(convert("<pre><code>x = 1</code></pre>", { codeBlockStyle: "indented" })).toBe("    x = 1");
    });

    it("keeps the fenced form", () => {
        expect(convert("<pre><code>x = 1</code></pre>", { codeBlockStyle: "fenced" })).toBe("```\nx = 1\n```");
    });
});
