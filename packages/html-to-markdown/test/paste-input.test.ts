/* eslint-disable no-secrets/no-secrets, unicorn/prefer-dom-node-append -- HTML samples, not secrets; domino, the test parser, has no append. */
import { createDocument } from "@mixmark-io/domino";
import { describe, expect, it, vi } from "vitest";

import { setHTMLParser } from "../src/html-parser";
import TurndownService, { paste, PASTE_OPTIONS } from "../src/index";
import { wrapLooseListText } from "../src/paste-input";

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
        expect(convert("<ol><li>a</li>b <i>c</i><li>d</li></ol>")).toBe("1. a\n   b *c*\n2. d");
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

describe("paste input: review cases", () => {
    it("refuses table parts nested in each other past the depth any element may reach, before copying a node", () => {
        const document = createDocument("<table></table>");
        let parent = document.querySelector("table") as Element;

        for (let level = 0; level < 1100; level += 1) {
            const row = document.createElement("tr");

            parent.appendChild(row);
            parent = row;
        }

        parent.appendChild(document.createTextNode("x"));

        // Refused by the depth check, before anything copies the node: not by a stack that ran out.
        const copied = vi.spyOn(document.body, "cloneNode");

        expect(() => convert(document.body)).toThrow(new RangeError("Nested too deep to convert"));
        expect(copied).not.toHaveBeenCalled();
    });

    it("measures the items it makes of loose list text, so lists nested through them count against the budget", () => {
        expect(() => convert(`${"<ul>a<span>".repeat(160)}${"a<br>".repeat(1000)}`)).toThrow(RangeError);
    });

    it("counts the re-indenting of a list placed straight in a list", () => {
        expect(() => convert(`${"<ul><li>a</li>".repeat(450)}<li>${"a<br>".repeat(300)}</li>`)).toThrow(RangeError);
    });

    it("counts formatting nested around one long line", () => {
        expect(() => convert(`${`<span style="font-weight:bold">`.repeat(450)}${"word ".repeat(20_000)}`)).toThrow(RangeError);
    });

    it("counts a run of whitespace once and the text of a script as none, as the conversion sees them", () => {
        expect(convert(`<b>a<br>${" ".repeat(3_000_000)}b</b>`)).toBe("**a\nb**");
        expect(convert(`<b>a<br><script>${"x".repeat(3_000_000)}</script>b</b>`)).toBe("**a\nb**");
    });

    it("makes no item of loose text that the page hides inside a shown element", () => {
        expect(convert(`<ul><li>a</li><span><span style="display:none">hidden</span></span><li>b</li></ul>`)).toBe("- a\n- b");
    });

    it("keeps loose text on one line across a block the page hides", () => {
        expect(convert("<ul>before<div hidden>ignored</div>after</ul>")).toBe("- beforeafter");
    });

    it("reads raised text from the text the page shows, not from its Markdown", () => {
        expect(convert(String.raw`<p>x<sup>\-2</sup></p>`)).toBe(String.raw`x\\-2`);
        expect(convert("<p>E=mc<sup><strong>2</strong></sup></p>")).toBe("E=mc**²**");
        expect(convert(`<p>E=mc<sup>2<span style="display:none">x</span></sup></p>`)).toBe("E=mc²");
    });
});

describe("paste input: review cases, second round", () => {
    it("counts inline code nested around a long text, which reads all of it again", () => {
        expect(() => convert(`${"<code>".repeat(450)}${"x".repeat(50_000)}`)).toThrow(RangeError);
    });

    it("keeps raised text as written when it holds a line break, a link or lowered text of its own", () => {
        expect(convert("<p>x<sup>2<br>3</sup></p>")).toBe("x2\n3");
        expect(convert(`<p>Fact<sup><a href="https://x.y/">1</a></sup></p>`)).toBe("Fact[1](https://x.y/)");
        expect(convert("<p>x<sup>2<sub>3</sub></sup></p>")).toBe("x2₃");
    });

    it("counts no work for text the page hides, such as a text area's", () => {
        expect(convert(`<b>a<br><textarea>${"x".repeat(3_000_000)}</textarea>b</b>`)).toBe("**a\nb**");
    });

    it("makes an item of an emoji placed straight in a list", () => {
        expect(convert(`<ul><li>a</li><img alt="🎉" src="x.png"><li>b</li></ul>`)).toBe("- a\n- 🎉\n- b");
        expect(convert(`<ul><li>a</li><span><img alt="🎉" src="x.png"></span></ul>`)).toBe("- a\n- 🎉");
    });

    it("reads each list's loose text once, not again for each list around it", () => {
        const document = createDocument(`${"<ul><span>".repeat(200)}${"x ".repeat(50)}`);
        let asked = 0;
        const shown = {
            imageText: () => "",
            isHidden: () => {
                asked += 1;

                return false;
            },
            mathText: () => "",
        };

        wrapLooseListText(document.body, shown);

        expect(asked).toBeLessThan(200 * 10);
    });
});

describe("paste input: review cases, third round", () => {
    it("counts raised text nested around a long text, which maps all of it again", () => {
        expect(() => convert(`${"<sup>".repeat(450)}${"1".repeat(50_000)}`)).toThrow(RangeError);
    });

    it("counts the whitespace code keeps, and the lines of a code block, against the quotes around them", () => {
        expect(() => convert(`${"<blockquote>".repeat(100)}<code>a${" ".repeat(300_000)}b</code>`)).toThrow(RangeError);
        expect(() => convert(`${"<blockquote>".repeat(100)}<pre>${"a\n".repeat(150_000)}</pre>`)).toThrow(RangeError);
        expect(convert(`<blockquote><code>a${" ".repeat(10)}b</code></blockquote>`)).toBe(`> \`a${" ".repeat(10)}b\``);
    });
});

describe("paste input: review cases, fourth round", () => {
    it("writes no blank line or trailing space for a <br> that starts or ends a list item or a quote", () => {
        expect(convert("<ul><li><br>a</li><li>b<br><br></li><li>c</li></ul>")).toBe("- a\n- b\n- c");
        expect(convert("<blockquote>q<br><br></blockquote><p>after</p>")).toBe("> q\n\nafter");
    });

    it("ends the paste at its last text, past trailing line breaks", () => {
        expect(convert("<p>foo<br><br></p>")).toBe("foo");
    });

    it("gives an empty string back without parsing it, so it needs no HTML parser", () => {
        setHTMLParser(undefined);

        try {
            expect(convert("")).toBe("");
        } finally {
            setHTMLParser(createDocument);
        }
    });
});

describe("paste input: review cases, fifth round", () => {
    it("writes no quote marker for a quote that holds only what the page hides", () => {
        expect(convert(`<p>a</p><blockquote><span style="display:none">hidden</span></blockquote><p>b</p>`)).toBe("a\n\nb");
    });

    it("writes repeated or leading line breaks in a table cell as one space", () => {
        expect(convert("<table><tr><th>A</th></tr><tr><td>a<br><br>b</td></tr><tr><td><br>c</td></tr></table>")).toBe("| A |\n| --- |\n| a b |\n| c |");
    });
});

describe("paste input: review cases, sixth round", () => {
    it("counts the formula an image stands for, which may be long", () => {
        const formula = `<img class="math" alt="${"x+".repeat(25_000)}1" src="f.png">`;

        expect(() => convert(`${"<b>".repeat(450)}${formula}`)).toThrow(RangeError);
    });

    it("takes out marks a character reference decodes into, so only the preset writes them", () => {
        expect(convert("<p>a&#3;b&#4;c&#16;d&#1;e</p>")).toBe("abcde");
    });
});

describe("paste input: review cases, seventh round", () => {
    it("writes no blank line for a div that holds only what the page hides or drops", () => {
        expect(convert(`<div>a</div><div><span style="display:none">x</span></div><div><img src="p.png"></div><div>b</div>`)).toBe("a\nb");
    });

    it("numbers a numbered list's items as the page does, with loose text on a line of its own", () => {
        expect(convert("<ol><li>a</li>note<li>b</li></ol>")).toBe("1. a\n   note\n2. b");
        expect(convert("<ol>note<li>a</li></ol>")).toBe("note\n\n1. a");
    });
});

describe("paste input: review cases, eighth round", () => {
    it("counts a link's destination, which the link writes again for each formatting element around it", () => {
        expect(() => convert(`${"<b>".repeat(450)}<a href="https://x.y/${"a".repeat(50_000)}">l</a>`)).toThrow(RangeError);
    });

    it("marks each paragraph of formatting that a repeated <br> parts", () => {
        expect(convert(`<span style="font-weight:bold">a<br><br>b</span>`)).toBe("**a**\n\n**b**");
        expect(convert(`<p style="font-style:italic">a<br><br>b</p>`)).toBe("*a*\n\n*b*");
    });
});

describe("paste input: review cases, ninth round", () => {
    it("counts no work inside an element the page hides, though its depth is still checked", () => {
        expect(convert(`<p>a</p><div style="display:none">${"<sup>".repeat(450)}${"1".repeat(50_000)}</div>`)).toBe("a");
    });

    it("counts no formatting work for a style that sets no formatting, such as a color", () => {
        expect(convert(`${`<span style="color:red">`.repeat(450)}${"word ".repeat(20_000)}`)).toContain("word word");
    });

    it("writes no blank line for a <br> that starts a div", () => {
        expect(convert("<div>a</div><div><br>b</div>")).toBe("a\nb");
    });

    it("keeps loose text in a numbered list out of an item the page hides", () => {
        expect(convert("<ol><li hidden>x</li><div>block</div>note<li>b</li></ol>")).toContain("note");
    });

    it("makes an item of loose text a nested numbered list hands to the list around it", () => {
        expect(convert("<ul><li>a</li><ol>note<li>b</li></ol></ul>")).toBe("- a\n- note\n  1. b");
    });
});

describe("paste input: review cases, tenth round", () => {
    it("counts an emoji as the two string units it is rebuilt as", () => {
        expect(() => convert(`${"<b>".repeat(400)}${"😀".repeat(26_000)}`)).toThrow(RangeError);
    });

    it("counts plain elements nested around long text, each of which joins all it holds again", () => {
        expect(() => convert(`<span>${"x".repeat(1000)}`.repeat(450))).toThrow(RangeError);
        expect(convert(`${"<span>".repeat(20)}${"x ".repeat(100_000)}`)).toContain("x x");
    });

    it("keeps loose text after a block in a numbered list in its place", () => {
        expect(convert("<ol><li>a</li><div>block</div>note</ol>")).toBe("1. a\nblock\nnote");
    });
});

describe("paste input: review cases, eleventh round", () => {
    it("moves no loose text out of a list the page hides", () => {
        expect(convert("<ul><li>a</li><ol hidden>secret<li>x</li></ol><li>b</li></ul>")).toBe("- a\n- b");
        expect(convert(`<ul><li>a</li><div style="display:none"><ol>secret<li>x</li></ol></div><li>b</li></ul>`)).toBe("- a\n- b");
    });
});

describe("paste input: review cases, twelfth round", () => {
    it("counts no formatting work for a font family, which formats nothing", () => {
        expect(convert(`${`<span style="font-family:Arial">`.repeat(450)}${"word ".repeat(20_000)}`)).toContain("word word");
        expect(() => convert(`${`<span style="font: bold 12px Arial">`.repeat(450)}${"word ".repeat(20_000)}`)).toThrow(RangeError);
    });

    it("keeps a blank line for each line break of a div that holds only breaks", () => {
        expect(convert("<div>two</div><div><br><br></div><div>four</div>")).toBe("two\n\n\nfour");
        expect(convert("<div>two</div><div><br></div><div>four</div>")).toBe("two\n\nfour");
    });
});

describe("paste input: review cases, thirteenth round", () => {
    it("counts the TeX source a formula is written as", () => {
        const tex = `<math><semantics><mi>x</mi><annotation encoding="application/x-tex">${"x+".repeat(25_000)}1</annotation></semantics></math>`;

        expect(() => convert(`${"<b>".repeat(450)}${tex}`)).toThrow(RangeError);
    });

    it("keeps text that leads a numbered list passed in on its own off the first item's line", () => {
        const document = createDocument("<ol>note<li>a</li></ol>");
        const list = document.querySelector("ol") as Element;

        expect(convert(list)).toBe("note\n1. a");
        expect(list.outerHTML).toBe("<ol>note<li>a</li></ol>");
    });
});

describe("paste input: review cases, fourteenth round", () => {
    it("parts a div that holds a block inside an inline wrapper from the next line", () => {
        expect(convert("<div><span><p>a</p></span></div><div>b</div>")).toBe("a\n\nb");
    });

    it("counts nothing for the destination of a link written as its text alone", () => {
        expect(convert(`${"<b>".repeat(450)}<a href="javascript:${"a".repeat(50_000)}">label</a>`)).toContain("label");
    });

    it("keeps each blank line of break-only divs side by side", () => {
        expect(convert("<div>a</div><div><br></div><div><br></div><div>b</div>")).toBe("a\n\n\nb");
        expect(convert("<div>two</div><div><br></div><div>four</div>")).toBe("two\n\nfour");
    });
});
