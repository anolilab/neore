import TurndownUpstream from "turndown";
import { describe, expect, it } from "vitest";

import type { Options } from "../src/index";
import TurndownService from "../src/index";

function convert(html: string, options: Partial<Options> = {}): string {
    return new TurndownService(options).turndown(html);
}

function upstream(html: string): string {
    return new TurndownUpstream().turndown(html);
}

/*
 * Inline emphasis and line breaks. Each block is one reported issue (upstream
 * numbers in the names). The "unchanged" cases pin output the fixes must not touch.
 */

describe("adjacent emphasis (#512, #442)", () => {
    it("merges adjacent emphasis into one run", () => {
        expect(convert("<i>1</i><i>2</i><em>3</em><em>4</em>")).toBe("_1234_");
    });

    it("merges emphasis split inside a paragraph", () => {
        expect(convert("<p>An <em>emphas</em><em>is</em></p>")).toBe("An _emphasis_");
    });

    it("uses the emphasis delimiter option for a merged run", () => {
        expect(convert("<em>a</em><em>b</em>", { emDelimiter: "*" })).toBe("*ab*");
    });

    it("keeps a hard break inside a merged run", () => {
        expect(convert("<em>a<br></em><em>b</em>")).toBe("_a  \nb_");
    });

    it("does not merge across two breaks, which would be a blank line", () => {
        expect(convert("<em>a<br></em><em><br>b</em>")).toBe("_a_  \n  \n_b_");
    });

    it("merges adjacent strong into one run", () => {
        expect(convert("<strong>a</strong><b>b</b>")).toBe("**ab**");
    });

    it("unchanged: emphasis separated by a space stays separate", () => {
        expect(convert("<em>a</em> <em>b</em>")).toBe("_a_ _b_");
    });

    it("merges a long run without changing the output", () => {
        expect(convert("<em>x</em>".repeat(300))).toBe(`_${"x".repeat(300)}_`);
    });
});

describe("runs stop at block edges (review)", () => {
    // The block-containing element keeps the delimiters upstream writes around it, so these
    // outputs match upstream. The run itself never reaches past the block.
    it("does not merge strong across a block", () => {
        expect(convert("<strong>a<div>b</div></strong><strong>c</strong>")).toBe("**a\n\nb\n\n****c**");
    });

    it("does not merge emphasis across a block", () => {
        expect(convert("<em>a</em><em><div>b</div>c</em>")).toBe("_a__\n\nb\n\nc_");
    });
});

describe("nested emphasis of the same kind (review)", () => {
    it("writes an inner element of a merged run without delimiters", () => {
        expect(convert("<em>a</em><em><em>b</em></em>")).toBe("_ab_");
    });

    it("writes an inner element without delimiters inside its parent", () => {
        expect(convert("<em>a<em>b</em>c</em>")).toBe("_abc_");
    });

    it.each(["<b>a<b>c</b><div>d</div></b>", "<strong>a<strong>b<div>c</div></strong></strong>", "<em><i>x</i><p>y</p></em>"])(
        "keeps an inner element's delimiters when its same-kind parent holds a block: %s",
        (html) => {
            expect(convert(html)).toBe(upstream(html));
        },
    );

    // A block that prints nothing does not keep the inner element's delimiters. Each output renders
    // as the inner text in one emphasis (CommonMark: <em>a</em>, <strong>a</strong>, <em>[</em>).
    it.each([
        ["<em><em>a</em><span><p></p></span></em>", "_a_"],
        ["<strong><strong>a</strong><span><div></div></span></strong>", "**a**"],
        ["<i><em>[</em><br><b><p></p></b></i>", String.raw`_\[_`],
    ])("writes an inner element without delimiters when its parent's block prints nothing: %s", (html, expected) => {
        expect(convert(html)).toBe(expected);
    });
});

describe("blank blocks split nested emphasis (review)", () => {
    // A blank block prints a paragraph break, so it splits the parent's delimiters, as upstream does.
    it.each([
        "<em><em>a</em><p></p>b</em>",
        "<b>x<p></p><b>y</b></b>",
        "<em><em>a</em><p><span> </span></p></em>",
        "<b><strong>><h3>  </h3></strong><i></i>(</b>",
    ])("matches upstream when a blank block sits inside the emphasis: %s", (html) => {
        expect(convert(html)).toBe(upstream(html));
    });
});

describe("whitespace-only emphasis (review)", () => {
    it("ends a run, as upstream does", () => {
        expect(convert("<b>a</b><strong> </strong><b>c</b>")).toBe("**a** **c**");
    });

    it("passes over an empty emphasis element", () => {
        expect(convert("<em>a</em><em></em><em>b</em>")).toBe("_ab_");
    });
});

describe("inline code keeps upstream's trim (review)", () => {
    it("drops an edge break in a code span, as upstream does", () => {
        expect(convert("x<code> y<br></code>z")).toBe("x `y`z");
    });
});

describe("intraword emphasis (#441)", () => {
    it("uses * when the emphasis touches a word character", () => {
        expect(convert("Bru<em>ss</em>el<em>s</em>")).toBe("Bru*ss*el*s*");
    });

    it("uses * for a merged run that touches a word character", () => {
        expect(convert("Bru<em>ss</em><em>el</em>x")).toBe("Bru*ssel*x");
    });

    it("unchanged: emphasis next to punctuation and spaces keeps _", () => {
        expect(convert("a <em>b</em>, c")).toBe("a _b_, c");
    });

    it("unchanged: emphasis after strong keeps _", () => {
        expect(convert("<strong>1</strong><em>2</em>")).toBe("**1**_2_");
    });
});

describe("line breaks at the edge of an element (#509, #436, #405)", () => {
    it("keeps a trailing break when the element has leading space (#509)", () => {
        expect(convert("<span>abc</span><span> def<br></span><span>ghi</span>")).toBe("abc def  \nghi");
    });

    it("moves a leading and trailing break outside strong delimiters (#436)", () => {
        expect(convert("<p>Before<strong><br>Strong Text<br></strong></p>")).toBe("Before  \n**Strong Text**");
    });

    it("moves a leading break outside strong delimiters at the start (#436)", () => {
        expect(convert("<strong><br>Strong Text<br></strong>")).toBe("  \n**Strong Text**");
    });

    it("moves a trailing break outside em delimiters (#405)", () => {
        expect(convert("<em>foo<br/></em>")).toBe("_foo_");
    });

    it("moves a trailing break outside strong delimiters past an empty element", () => {
        expect(convert("<strong>a<br><span></span></strong>b")).toBe("**a**  \nb");
    });

    it("keeps a break that is the only content of emphasis", () => {
        expect(convert("<p>a<em><br></em>b</p>")).toBe("a  \nb");
    });
});

describe("line breaks in headings (#555)", () => {
    it("replaces a break in an ATX heading with a space", () => {
        expect(convert("<h3>Chapter 1<br>The Beginning</h3>")).toBe("### Chapter 1 The Beginning");
    });

    it("replaces a break in a setext heading with a space, and sizes the underline to it", () => {
        expect(convert("<h1>Chapter 1<br>The Beginning</h1>")).toBe(`Chapter 1 The Beginning\n${"=".repeat(23)}`);
    });

    it("keeps the block separators when a break comes before a block (review)", () => {
        expect(convert("<h2>a<br><p>b</p></h2>")).toBe("a\n\nb\n\n\n------");
    });

    it("keeps a horizontal rule on its own line when a break comes before it (review)", () => {
        expect(convert("<h2>x<br><hr>y</h2>")).toContain("x\n\n* * *\n\ny");
    });

    it("drops the spaces that touch a trailing break (review)", () => {
        expect(convert("<h3>a<br></h3>")).toBe("### a");
    });
});

describe("line breaks inside code blocks (#514)", () => {
    const html = "<div><pre><code>First line<br>Second line<br>Third line</code></pre></div>";

    it("writes each break as a newline in an indented code block", () => {
        expect(convert(html)).toBe("    First line\n    Second line\n    Third line");
    });

    it("writes each break as a newline in a fenced code block", () => {
        expect(convert(html, { codeBlockStyle: "fenced" })).toBe("```\nFirst line\nSecond line\nThird line\n```");
    });
});

describe("edge breaks are restored only when trimming removed them (Qodo)", () => {
    it("does not add a break before a link that already starts with one", () => {
        expect(convert("x<span><a href=/u><br>foo</a> </span>y")).toBe("x[  \nfoo](/u) y");
    });

    it("writes a custom break marker once when the element ends with one", () => {
        expect(convert("<p>x<span> y<br> </span>z</p>", { br: "<br>" })).toBe("x y<br>\nz");
    });
});

describe("emphasis looks past void elements that print nothing (Qodo)", () => {
    it("reads the word on the far side of a word-break hint", () => {
        expect(convert("Brus<wbr><em>sel</em><wbr>s")).toBe("Brus*sel*s");
    });

    it("reads past an image with no source, which prints nothing", () => {
        expect(convert("Brus<img><em>sel</em><img>s")).toBe("Brus*sel*s");
    });

    it("keeps the plain delimiter beside an image with a source, which prints markup", () => {
        expect(convert("<em>a</em><img src=x.png>b")).toBe("_a_![](x.png)b");
    });
});

describe("emphasis beside an anchor that prints plain text (Qodo)", () => {
    it("reads the text of an anchor with no href", () => {
        expect(convert("<em>x</em><a>y</a>")).toBe("*x*y");
    });

    it("reads the text of an unsafe link when safe links are on", () => {
        expect(convert("<em>x</em><a href=javascript:alert(1)>y</a>", { safeLinks: true })).toBe("*x*y");
    });

    it("keeps the plain delimiter beside a link, which prints brackets", () => {
        expect(convert("<em>x</em><a href=/u>y</a>")).toBe("_x_[y](/u)");
    });
});

describe("headings keep the block separators when the break marker is empty (Qodo)", () => {
    it("flattens a break in a heading but keeps the paragraph breaks around a block", () => {
        expect(convert("<h2>a<p>b</p>c<br>d</h2>", { br: "" })).toBe("a\n\nb\n\nc d\n---------");
    });

    it("still flattens every break in a heading with no block", () => {
        expect(convert("<h1>a<br><br>b</h1>", { br: "" })).toBe("a b\n===");
    });

    // With br "\n" the break marker is "\n\n", the same text a block separator writes, so a heading with a block must not
    // flatten the separator. The break is written as a space and the paragraph break after it is kept.
    it("keeps the paragraph break around a block when the break marker is a blank line (setext)", () => {
        expect(convert("<h1>a<br>b<div>c</div></h1>", { br: "\n" })).toBe("a b\n\nc\n======");
    });

    it("keeps the paragraph break around a block when the break marker is a blank line (atx)", () => {
        expect(convert("<h1>a<br>b<div>c</div></h1>", { br: "\n", headingStyle: "atx" })).toBe("# a b\n\nc");
    });

    it("still flattens a break in a heading with no block when the break marker is a blank line", () => {
        expect(convert("<h1>a<br>b</h1>", { br: "\n" })).toBe("a b\n===");
    });
});
