import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import TurndownService, { paste, PASTE_OPTIONS } from "../src/index";

/*
 * The paste preset's list forms. The cases follow the composer's paste tests (apps/web, composer-paste/paste-plan.test.ts),
 * with one difference in form: a nested item is indented to its parent's text, as in the preset's other lists, where the
 * composer indents four spaces a level.
 */

function convert(html: string): string {
    return new TurndownService(PASTE_OPTIONS).use(paste).turndown(html);
}

function fixture(name: string): string {
    return readFileSync(new URL(`../bench/fixtures/${name}`, import.meta.url), "utf8");
}

/** A Word list paragraph: Word writes the marker in text it hides, with spaces after it. */
function wordItem(level: number, marker: string, text: string): string {
    return `<p class=MsoListParagraph style='mso-list:l0 level${String(level)} lfo1'><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span>${text}</p>`;
}

describe("paste lists: Google Docs", () => {
    it("writes a Google Docs list and leaves out the normal-weight bold it wraps a copy in", () => {
        expect(convert(fixture("google-docs-list.html"))).toBe(
            "Release plan\n\n- **Ship** the beta on Monday\n- Read the [release notes](https://example.com/notes)\n  - *twice*",
        );
    });

    it("numbers each depth of a flat numbered list on its own and indents every line of a nested item", () => {
        expect(convert(fixture("google-docs-numbered.html"))).toBe("1. Install\n   1. Download\n      the installer\n   2. Run it\n2. Sign in");
    });

    it("starts a list copied from a nested item at the left edge, keeping its nesting", () => {
        expect(convert(`<ul><li aria-level="2">a</li><li aria-level="3">b</li><li aria-level="2">c</li></ul>`)).toBe("- a\n  - b\n- c");
    });

    it("restarts a depth's numbers under each item above it", () => {
        expect(convert(`<ol><li aria-level="1">a</li><li aria-level="2">b</li><li aria-level="1">c</li><li aria-level="2">d</li></ol>`)).toBe(
            "1. a\n   1. b\n2. c\n   1. d",
        );
    });

    it("nests an item that skips a level under the item before it", () => {
        expect(convert(`<ul><li aria-level="1">a</li><li aria-level="3">deep</li><li aria-level="2">mid</li></ul>`)).toBe("- a\n  - deep\n  - mid");
    });
});

describe("paste lists: Word", () => {
    it("writes Word's list paragraphs as list items, without the spaces after the hidden marker", () => {
        expect(convert(`<p>before</p>${wordItem(1, "·", "one")}\n${wordItem(1, "·", "two")}<p>after</p>`)).toBe("before\n\n- one\n- two\n\nafter");
    });

    it("starts a list copied from a nested level at the left edge, keeping its nesting", () => {
        expect(convert(wordItem(2, "o", "a") + wordItem(3, "o", "b") + wordItem(2, "o", "c"))).toBe("- a\n  - b\n- c");
    });

    it("does not start the list at a level-one item in hidden text", () => {
        expect(convert(`<p>Steps</p><div style="display:none">${wordItem(1, "o", "secret")}</div>${wordItem(3, "o", "a")}`)).toBe("Steps\n\n- a");
    });

    it("keeps one list across a hidden item", () => {
        const hidden = `<p style="mso-list:l0 level1 lfo1;display:none"><span style="mso-list:Ignore">o</span>secret</p>`;

        expect(convert(wordItem(2, "o", "a") + hidden + wordItem(3, "o", "b"))).toBe("- a\n  - b");
    });

    it("keeps a number Word shows, up to nine digits", () => {
        expect(convert(wordItem(1, "10000.", "ten thousand"))).toBe("10000. ten thousand");
    });

    it("keeps a lettered or roman marker as text after a bullet, nesting under the bullet's text", () => {
        expect(convert(wordItem(1, "1.", "First") + wordItem(2, "a.", "Sub") + wordItem(3, "i.", "Deep"))).toBe("1. First\n   - a. Sub\n     - i. Deep");
        expect(convert(wordItem(1, "a)", "one") + wordItem(1, "b)", "two"))).toBe("- a) one\n- b) two");
    });

    it("takes the marker only from text Word shows, not from a marker inside other hidden text", () => {
        expect(convert(`<p style="mso-list:l0 level1 lfo1"><span style="display:none"><span style="mso-list:Ignore">9.</span></span>visible</p>`)).toBe(
            "- visible",
        );
    });

    it("keeps an item's later lines in the item", () => {
        expect(
            convert(
                `<p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">1.</span>one<br>two</p><p style="mso-list:l0 level2 lfo1"><span style="mso-list:Ignore">o</span>three<br>four</p>`,
            ),
        ).toBe("1. one\n   two\n   - three\n     four");
    });
});

describe("paste lists: numbering", () => {
    it("keeps letters and roman numerals as text after a bullet, since Markdown numbers only in digits", () => {
        expect(convert(`<ol type="A"><li>one</li><li>two</li></ol><ol type="i" start="3"><li>three</li><li>four</li></ol><ol type="1"><li>one</li></ol>`)).toBe(
            "- A. one\n- B. two\n\n- iii. three\n- iv. four\n\n1. one",
        );
    });

    it("writes a lettered or roman list's numbers it has no form for in digits, still after a bullet", () => {
        expect(convert(`<ol type="a" start="0"><li>z</li><li>a</li></ol><ol type="I" start="4000"><li>big</li></ol>`)).toBe("- 0. z\n- a. a\n\n- 4000. big");
    });

    it("keeps a number below 0 as text after a bullet, since Markdown numbers only from 0", () => {
        expect(convert(`<ol start="-2"><li>alpha</li><li>beta</li><li>gamma</li></ol>`)).toBe("- -2. alpha\n- -1. beta\n0. gamma");
    });
});

describe("paste lists: a list placed straight in a list", () => {
    it("goes under the item before it, as it would inside that item", () => {
        expect(convert("<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>")).toBe(convert("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>"));
        expect(convert("<ol><li>a</li><ol><li>b</li></ol><li>c</li></ol>")).toBe("1. a\n   1. b\n2. c");
        expect(convert("<ul><li>a</li><ul><li>b</li></ul></ul>")).toBe("- a\n  - b");
    });

    it("stays a list of its own when no item comes before it", () => {
        expect(convert("<ul><ul><li>b</li></ul><li>a</li></ul>")).toBe("- b\n\n- a");
    });
});

describe("paste lists: review cases", () => {
    /** A Word list paragraph of list `id`, with styles added to its marker. */
    function listParagraph(id: string, level: number, marker: string, text: string, markerStyle = ""): string {
        return `<p style="mso-list:${id} level${String(level)} lfo1"><span style="mso-list:Ignore${markerStyle}">${marker}</span>${text}</p>`;
    }

    it("takes no number from a marker the page hides for a reason of its own", () => {
        expect(convert(listParagraph("l0", 1, "9.", "visible", ";display:none"))).toBe("- visible");
    });

    it("leaves nothing for a list placed straight in a list whose items are all hidden", () => {
        expect(convert(`<ul><li>a</li><ul><li style="display:none">x</li></ul><li>b</li></ul>`)).toBe("- a\n- b");
    });

    it("parts two Word lists side by side, each placed from its own top level", () => {
        expect(
            convert(
                listParagraph("l0", 1, "·", "a") + listParagraph("l0", 2, "o", "a2") + listParagraph("l1", 2, "o", "b") + listParagraph("l1", 3, "o", "b2"),
            ),
        ).toBe("- a\n  - a2\n\n- b\n  - b2");
    });

    it("keeps bold set to the relative weight lighter, which a heavy weight leaves bold", () => {
        expect(convert(`<b style="font-weight:lighter">x</b> <strong style="font-weight:normal">y</strong>`)).toBe("**x** y");
    });

    it("keeps the number of a Word numbered heading, which is no list item", () => {
        expect(convert(`<h1 style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">1.</span> Intro</h1>`)).toBe(String.raw`# 1\. Intro`);
    });

    it("keeps Word marker text that is no Markdown number after a bullet, escaped as text", () => {
        expect(
            convert(
                [
                    listParagraph("l0", 1, "1.1.", "one"),
                    listParagraph("l0", 1, "(a)", "two"),
                    listParagraph("l0", 1, "Article 1.", "three"),
                    listParagraph("l0", 1, "1000000000.", "four"),
                ].join(""),
            ),
        ).toBe(String.raw`- 1.1. one
- (a) two
- Article 1. three
- 1000000000\. four`);
    });

    it("writes a number of more than nine digits as text after a bullet, since a marker takes nine", () => {
        expect(convert(`<ol start="1000000000"><li>a</li><li aria-level="2">b</li></ol>`)).toBe("- 1000000000. a\n  1. b");
    });
});
