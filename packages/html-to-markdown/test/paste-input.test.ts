/* eslint-disable no-secrets/no-secrets -- HTML samples, not secrets. */
import { createDocument } from "@mixmark-io/domino";
import { describe, expect, it } from "vitest";

import TurndownService, { paste, PASTE_OPTIONS } from "../src/index";

/*
 * The paste preset's budgets, and the forms of raised and lowered text, inline code, line breaks and loose list text.
 * The cases follow the composer's paste tests (apps/web, composer-paste/paste-plan.test.ts).
 */

function convert(input: string | Node): string {
    return new TurndownService(PASTE_OPTIONS).use(paste).turndown(input);
}

describe("paste budgets", () => {
    it("refuses HTML nested deeper than it converts, so the caller pastes the plain text", () => {
        expect(() => convert(`${"<div>".repeat(600)}a`)).toThrow(RangeError);
        expect(() => convert("<ul><li>a</li>".repeat(600))).toThrow(RangeError);
        expect(() => convert(`${"<ul><li>".repeat(600)}deep`)).toThrow(RangeError);
    });

    it("refuses quotes nested so deep around many lines that re-indenting them is quadratic", () => {
        expect(() => convert(`${"<blockquote>".repeat(300)}${"a<br>".repeat(1000)}`)).toThrow(RangeError);
        expect(convert(`${"<blockquote>".repeat(3)}a`)).toBe("> > > a");
    });

    it("refuses formatting nested hundreds deep around many lines, each of which rebuilds them", () => {
        expect(() => convert(`${"<b>".repeat(400)}${"line<br>".repeat(5000)}${"</b>".repeat(400)}`)).toThrow(RangeError);
        expect(convert(`<b><i>${"line<br>".repeat(3)}</i></b>`)).toBe("***line\nline\nline***");
    });

    it("counts a table nested in a cell one level deep, not one per part between the table and its cell", () => {
        const depth = 200;
        const html = `${"<table><tr><td>".repeat(depth)}r${"</td></tr></table>".repeat(depth)}`;

        expect(convert(html)).toBe("| r |\n| --- |");
    });
});

describe("paste: raised and lowered text", () => {
    it.each([
        ["an exponent", "<strong>E=mc<sup>2</sup></strong>", "**E=mc²**"],
        ["a chemical formula", "<p><b>H<sub>2</sub>O</b> and CO<sub>2</sub></p>", "**H₂O** and CO₂"],
        ["a signed exponent, escaped as text", "<p><i>x<sup>-(n+1)</sup></i></p>", "*x⁻⁽ⁿ⁺¹⁾*"],
        ["an ordinal, kept as text", "<p>12<sup>th</sup> <b>May</b></p>", "12th **May**"],
        ["a footnote mark, kept as text", "<p>Fact<sup>[1]</sup></p>", String.raw`Fact\[1\]`],
        ["an empty one", "<p>a<sup></sup>b</p>", "ab"],
    ])("keeps the raised or lowered meaning where Unicode can: %s", (_name, html, markdown) => {
        expect(convert(html)).toBe(markdown);
    });
});

describe("paste: inline code", () => {
    it("keeps the spaces the code holds, at its ends and inside", () => {
        expect(convert("<p>a <code> both </code> b <code> left</code></p>")).toBe("a `  both  ` b ` left`");
        expect(convert("<p>x <code>a  b</code> y</p>")).toBe("x `a  b` y");
    });
});

describe("paste: line breaks", () => {
    it("keeps the blank line of a repeated <br>", () => {
        expect(convert("<p>A<br><br>B</p><div>C<br>\n<br>D</div>")).toBe("A\n\nB\n\nC\n\nD");
    });

    it("leaves no trailing spaces on the blank lines of a list item or a quote", () => {
        expect(convert("<ul><li>step<pre>a\n\nb</pre></li></ul>")).toBe("- step\n\n  ```\n  a\n\n  b\n  ```");
        expect(convert("<blockquote><p>q</p><pre>a\nb</pre></blockquote>")).toBe("> q\n>\n> ```\n> a\n> b\n> ```");
        expect(convert("<ul><li>a<br><br>b</li></ul><blockquote>c<br><br>d</blockquote>")).toBe("- a\n\n  b\n\n> c\n>\n> d");
    });

    it("keeps text set back to normal weight across lines out of the bold", () => {
        expect(convert(`<b>a<br><span style="font-weight:normal">b</span><br>c</b>`)).toBe("**a**\nb\n**c**");
    });
});

describe("paste: text placed straight in a list", () => {
    it("is an item of its own, as the page shows it on a line of its own", () => {
        expect(convert("<ul><li>a</li><ul><li>b</li></ul><li>c</li>d</ul>")).toBe("- a\n  - b\n- c\n- d");
        expect(convert("<ol><li>a</li>b <i>c</i><li>d</li></ol>")).toBe("1. a\n2. b *c*\n3. d");
    });

    it("adds no item for blank text, a comment or an element the page hides", () => {
        expect(convert(`<ul><li>a</li> <!-- x --> <span style="display:none">hidden</span>\n<li>b</li></ul>`)).toBe("- a\n- b");
    });

    it("leaves a node passed in as it was", () => {
        const document = createDocument("<ul><li>a</li>b</ul>");
        const list = document.querySelector("ul") as Element;

        expect(convert(list)).toBe("- a\n- b");
        expect(list.outerHTML).toBe("<ul><li>a</li>b</ul>");
    });
});

describe("paste: a div per line", () => {
    it("is a line each, with a blank line for a div that holds only a line break", () => {
        expect(convert("<div>one <b>1</b></div> <div>two</div><div><br></div><div>four</div><p>para</p>")).toBe("one **1**\ntwo\n\nfour\n\npara");
    });

    it("parts a div that holds blocks from what is around it, as any block", () => {
        expect(convert("<div><p>a</p><p>b</p></div><div>c<br></div>")).toBe("a\n\nb\n\nc");
    });
});
