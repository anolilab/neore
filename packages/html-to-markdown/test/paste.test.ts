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
