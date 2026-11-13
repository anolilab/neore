import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import TurndownService, { declaredStyle, paste, PASTE_OPTIONS } from "../src/index";

/*
 * The paste preset. The expected output follows the composer's paste tests (apps/web, composer-paste/paste-plan.test.ts),
 * which the composer switch runs against this preset.
 */

function convert(html: string): string {
    return new TurndownService(PASTE_OPTIONS).use(paste).turndown(html);
}

describe("paste: hidden content", () => {
    it.each([
        [
            "a hidden style, a screen-reader class and aria-hidden",
            `<p>Hi <span style="visibility:hidden">secret</span><span class="sr-only">sr</span><b aria-hidden="true">x</b>there</p>`,
            "Hi there",
        ],
        ["aria-hidden in any case", `<p>shown<span aria-hidden="TRUE"> secret</span></p>`, "shown"],
        [
            "only a declaration that hides, not the same words inside another value",
            `<p><span style="background-image:url(https://example.com/display:none)">shown</span> <span style="display: none !important">gone</span></p>`,
            "shown",
        ],
        [
            "hidden list items",
            `<ol><li>one</li><li hidden>secret</li><li style="display:none">secret</li><li aria-hidden="true">secret</li><li>two</li></ol>`,
            "1. one\n2. two",
        ],
        [
            "hidden table rows and cells",
            `<table><tr><th>A</th><th style="display:none">S</th><th>B</th></tr><tr style="display:none"><td>secret</td></tr><tbody hidden><tr><td>secret</td></tr></tbody><tr><td>a</td><td aria-hidden="true">secret</td><td>b</td></tr></table>`,
            "| A | B |\n| --- | --- |\n| a | b |",
        ],
    ])("leaves out %s", (_name, html, expected) => {
        expect(convert(html)).toBe(expected);
    });

    it.each([
        [`<p style="display:none; display:block">Visible</p><p><b>bold</b></p>`, "Visible\n\n**bold**"],
        [`<p style="visibility:hidden; visibility:visible">Visible</p>`, "Visible"],
        [`<p style="display:block; display:none">secret</p><p>shown</p>`, "shown"],
        [`<p style="display:none !important; display:block">secret</p><p>shown</p>`, "shown"],
    ])("hides only what the last declaration hides, unless an earlier one is important: %s", (html, expected) => {
        expect(convert(html)).toBe(expected);
    });

    it("never keeps script, styles, comments, media, unsafe links or images that are not text", () => {
        const hostile = readFileSync(new URL("../bench/fixtures/hostile.html", import.meta.url), "utf8");

        expect(convert(hostile)).toBe("Hello **world**\n\nclick me");
    });
});

describe("paste: images and formulas", () => {
    it("keeps the text of emoji and formulas drawn as images, and drops other images", () => {
        expect(
            convert(
                `<p>Ship <img alt="🎉"> <img alt="👍🏽"> <img alt="👨‍👩‍👧"> <img alt=":tada:"> <img class="mwe-math-fallback-image-inline" alt="E=mc^2"> <img alt="A chart"> <img alt="Report 🎉"></p>`,
            ),
        ).toBe("Ship 🎉 👍🏽 👨‍👩‍👧 :tada: $E=mc^2$");
    });

    it("reads an image inside a picture", () => {
        expect(
            convert(
                `<p>Ship <picture><source srcset="https://x.y/a.webp"><img alt="🎉" src="https://x.y/a.png"></picture> <picture><img class="math" alt="x^2"></picture></p>`,
            ),
        ).toBe("Ship 🎉 $x^2$");
    });

    it("writes a formula's TeX source as inline math, with a delimiter a dollar sign inside cannot end", () => {
        expect(
            convert(
                `<p><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x$ [click](https://x.y/) $y</annotation></semantics></math> <img class="math" alt="$$a"></p>`,
            ),
        ).toBe("$$x$ [click](https://x.y/) $y$$ $$$ $$a $$$");
    });

    it("keeps a formula's visible text when it has no TeX source, and none of its other annotations", () => {
        expect(
            convert(
                `<p>Area <math><semantics><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><annotation encoding="StarMath">a + b</annotation></semantics></math> here</p>`,
            ),
        ).toBe("Area a+b here");
    });
});

describe("paste: composer forms", () => {
    it("writes list items with the marker and one space, later lines indented to the text", () => {
        expect(convert("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul><ol><li>one<br>two</li></ol>")).toBe("- a\n  - b\n- c\n\n1. one\n   two");
    });

    it("writes a line break as a plain newline", () => {
        expect(convert("<p>a<br>b</p>")).toBe("a\nb");
    });

    it("fences code and writes headings, emphasis and rules in the typed forms", () => {
        expect(convert("<h2>T</h2><p><i>i</i> <b>b</b></p><hr><pre><code>x</code></pre>")).toBe("## T\n\n*i* **b**\n\n---\n\n```\nx\n```");
    });

    it("writes a link whose destination is unsafe as its text", () => {
        expect(convert(`<p><a href="javascript:alert(1)">click</a></p>`)).toBe("click");
    });
});

describe("paste: declared styles", () => {
    it.each([
        ["font-weight:bold; font-weight:normal", "normal"],
        ["font-weight:bold !important; font-weight:normal", "bold"],
        ["FONT-WEIGHT: 700", "700"],
        ["color:red", ""],
    ])("reads %s as CSS does", (style, expected) => {
        expect(declaredStyle(style, "font-weight")).toBe(expected);
    });
});

describe("paste: review cases", () => {
    it("does not split a style at a semicolon inside a quoted value or a url()", () => {
        expect(convert(`<p><span style="background-image:url('x; display:none;')">shown</span></p>`)).toBe("shown");
        expect(declaredStyle(`content:"a; display:none"; display:block`, "display")).toBe("block");
    });

    it("writes a formula's line breaks as spaces, so the inline math stays on one line", () => {
        expect(convert(`<p><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x\n+ y</annotation></semantics></math></p>`)).toBe("$x + y$");
        expect(convert(`<p><img class="math" alt="x\n+ y"></p>`)).toBe("$x + y$");
    });

    it("numbers an item from its own value, and the items after it from there", () => {
        expect(convert(`<ol start="0"><li>zero</li><li>one</li></ol><ol><li>a</li><li value="5">five</li><li>six</li></ol>`)).toBe(
            "0. zero\n1. one\n\n1. a\n5. five\n6. six",
        );
    });
});

describe("paste: review cases, second round", () => {
    it("keeps a flag emoji drawn as an image", () => {
        expect(convert(`<p>Go <img alt="🇺🇸"></p>`)).toBe("Go 🇺🇸");
    });

    it("writes a list in a table cell as the cell's text, as the gfm rules do", () => {
        expect(convert("<table><tr><th>A</th></tr><tr><td><ul><li>a</li><li>b<ul><li>c</li></ul></li></ul></td></tr></table>")).toBe(
            "| A |\n| --- |\n| a; b; c |",
        );
    });

    it("reads a style with a CSS comment in it", () => {
        expect(convert(`<p>shown<span style="display:/**/none"> secret</span></p>`)).toBe("shown");
        expect(declaredStyle("display: none /* hide */", "display")).toBe("none");
    });

    it("finds a TeX annotation whatever the case of its encoding", () => {
        const encoding = "APPLICATION/X-TEX";

        expect(convert(`<p><math><semantics><mi>x</mi><annotation encoding="${encoding}">x^2</annotation></semantics></math></p>`)).toBe("$x^2$");
    });
});

describe("paste: review cases, third round", () => {
    it.each([`--x:"/*";display:none;--y:"*/"`, `content:"/*"; visibility:hidden`])("reads comment markers inside a quoted value as text: %s", (style) => {
        expect(convert(`<p>shown<span style='${style}'> secret</span></p>`)).toBe("shown");
    });
});

describe("paste: review cases, fourth round", () => {
    it("writes a closed details as its summary alone, an open one all of it", () => {
        expect(
            convert(
                "<details><summary>Logs</summary><p>hidden line</p>loose text</details><details><p>no summary</p></details><details open><summary>Shown</summary><p>body</p></details>",
            ),
        ).toBe("Logs\n\nShown\n\nbody");
    });

    it("leaves out a dialog that is not open", () => {
        expect(convert("<p>a</p><dialog><p>secret</p></dialog><dialog open><p>shown</p></dialog>")).toBe("a\n\nshown");
    });

    it("takes the first TeX annotation that has a source", () => {
        const encoding = "application/x-tex";

        expect(
            convert(
                `<p><math><semantics><mi>x</mi><annotation encoding="${encoding}"> </annotation><annotation encoding="${encoding}">x^2</annotation></semantics></math></p>`,
            ),
        ).toBe("$x^2$");
    });
});

describe("paste: review cases, fifth round", () => {
    it.each([
        ["an invalid later value", "display:none;display:bogus"],
        ["visibility:collapse", "visibility:collapse"],
        ["content-visibility:hidden", "content-visibility:hidden"],
    ])("hides text hidden by %s", (_name, style) => {
        expect(convert(`<p>shown<span style="${style}"> secret</span></p>`)).toBe("shown");
    });

    it("still lets a valid later value show the element", () => {
        expect(convert(`<p style="display:none; display:inline flow">shown</p>`)).toBe("shown");
    });

    it("reads only the formula's own TeX annotation, not one nested in another annotation", () => {
        const tex = "application/x-tex";

        expect(
            convert(
                `<p><math><semantics><mi>v</mi><annotation-xml encoding="MathML-Content"><semantics><ci>n</ci><annotation encoding="${tex}">nested</annotation></semantics></annotation-xml></semantics></math></p>`,
            ),
        ).toBe("v");
    });
});

describe("paste: review cases, sixth round", () => {
    it.each([
        ["a keyword combination CSS does not allow", "display:none;display:inline none"],
        ["a long gap before important", "display:none !          \t          important;display:block"],
    ])("hides text when %s follows a hiding declaration", (_name, style) => {
        expect(convert(`<p>shown<span style="${style}"> secret</span></p>`)).toBe("shown");
    });

    it("reads a comment inside a value as a break between words, as CSS does", () => {
        expect(convert(`<p><span style="display:no/**/ne">shown</span></p>`)).toBe("shown");
    });

    it("reads a formula image only from a class whose word is math", () => {
        expect(convert(`<p>a<img class="mathematics-logo" alt="Acme"> <img class="mwe-math-fallback" alt="x"></p>`)).toBe("a $x$");
    });

    it("finds a TeX annotation whose media type has a parameter", () => {
        const encoding = "application/x-tex; charset=utf-8";

        expect(convert(`<p><math><semantics><mi>v</mi><annotation encoding="${encoding}">x^2</annotation></semantics></math></p>`)).toBe("$x^2$");
    });
});
