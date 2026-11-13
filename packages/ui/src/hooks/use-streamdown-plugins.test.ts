import katex from "katex";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import type { Pluggable, PluggableList } from "unified";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

import { loadHeavyStreamdownPlugins, needsHeavyStreamdownPlugins, streamdownRehypePlugins } from "./use-streamdown-plugins";

const RAW_HTML = defaultRehypePlugins.raw as Pluggable;

/** Whether the check sends `text` through the raw-HTML step. */
const runsRawHtml = (text: string): boolean => streamdownRehypePlugins(text).includes(RAW_HTML);

describe("mermaid fences", () => {
    it("routes a fence that opens a numbered list item to the heavy plugin set", () => {
        expect(needsHeavyStreamdownPlugins("1. ```mermaid\ngraph TD\n```")).toBe(true);
        expect(needsHeavyStreamdownPlugins("2) ```mermaid\ngraph TD\n```")).toBe(true);
    });
});

describe("mhchem formulas", () => {
    it(String.raw`routes inline \(...\) formulas to the heavy plugin set`, () => {
        expect(needsHeavyStreamdownPlugins(String.raw`Water is \(\ce{H2O}\).`)).toBe(true);
    });

    it("routes a balanced single-dollar formula to the heavy plugin set", () => {
        expect(needsHeavyStreamdownPlugins(String.raw`Water is $\ce{H2O}$ and it costs $20.`)).toBe(true);
        expect(needsHeavyStreamdownPlugins("let $x^2$ be positive")).toBe(true);
    });

    it("keeps a lone currency marker on the basic plugin set, since it has no formula", () => {
        expect(needsHeavyStreamdownPlugins("it costs $20.")).toBe(false);
    });

    it("renders single-dollar formulas with the loaded plugin set", async () => {
        const plugins = await loadHeavyStreamdownPlugins();
        const html = renderToStaticMarkup(createElement(Streamdown, { plugins }, "let $x^2$ be positive"));

        expect(html).toContain('class="katex"');
    });

    it("leaves a lone currency marker unrendered as math with the loaded plugins, even mid-stream", async () => {
        const plugins = await loadHeavyStreamdownPlugins();

        for (const text of ["it costs $20.", "it costs $20"]) {
            const html = renderToStaticMarkup(createElement(Streamdown, { plugins }, text));

            expect(html).not.toContain('class="katex"');
            expect(html).toContain("$20");
        }
    });

    it(String.raw`renders \ce and \pu once the heavy plugins have loaded`, async () => {
        await loadHeavyStreamdownPlugins();

        // Without the mhchem contrib, KaTeX throws "Undefined control sequence".
        const html = katex.renderToString(String.raw`\ce{CO2 + C -> 2 CO}`, { throwOnError: true });

        expect(html).toContain("CO");
        expect(() => katex.renderToString(String.raw`\pu{123 kJ/mol}`, { throwOnError: true })).not.toThrow();
    });
});

const renderReply = (text: string, rehypePlugins = streamdownRehypePlugins(text)): string =>
    renderToStaticMarkup(createElement(Streamdown, { mode: "static", rehypePlugins }, text));

const hasHtmlNode = (node: { children?: unknown[]; type: string }): boolean =>
    node.type === "html" || (node.children ?? []).some((child) => hasHtmlNode(child as { children?: unknown[]; type: string }));

describe(streamdownRehypePlugins, () => {
    it("runs the raw-HTML step only for a reply with something that looks like a tag", () => {
        expect.assertions(4);

        expect(streamdownRehypePlugins("Plain **markdown**, 1 < 2 and a -> b.")).not.toContain(defaultRehypePlugins.raw);
        expect(streamdownRehypePlugins("Press <kbd>Ctrl</kbd>.")).toContain(defaultRehypePlugins.raw);
        // Sanitize and harden run either way.
        expect(streamdownRehypePlugins("plain")).toStrictEqual([defaultRehypePlugins.sanitize, defaultRehypePlugins.harden]);
        expect(streamdownRehypePlugins("<b>x</b>")).toStrictEqual([defaultRehypePlugins.raw, defaultRehypePlugins.sanitize, defaultRehypePlugins.harden]);
    });

    it("keeps the same list identity per kind, so a re-render does not re-parse every block", () => {
        expect.assertions(2);

        expect(streamdownRehypePlugins("one")).toBe(streamdownRehypePlugins("two"));
        expect(streamdownRehypePlugins("<i>one</i>")).toBe(streamdownRehypePlugins("<b>two</b>"));
    });

    it.each([
        "1 < 2 and 3 <= 4",
        "x<-y, a <> b, <3, < b>",
        "&lt;script&gt;alert(1)&lt;/script&gt;",
        "    indented <b>code</b> is matched anyway",
        "| a | b |\n| - | - |\n| 1 < 2 | ok |",
    ])("a reply the check calls plain has no HTML node to drop: %s", (text) => {
        expect.assertions(1);

        const tree = unified().use(remarkParse).use(remarkGfm).parse(text);

        expect(runsRawHtml(text) || !hasHtmlNode(tree)).toBe(true);
    });

    it("renders a plain reply exactly as the full default set does", () => {
        expect.assertions(1);

        const text = "# Title\n\nSome **bold**, `a < b`, 1 < 2, [link](https://example.com).\n\n- item\n\n| a | b |\n| - | - |\n| 1 | 2 |";

        // The HTML parser adds whitespace-only text between block elements, which the container's `whitespace-normal` collapses.
        const blocks = (html: string): string => html.replaceAll(/>\s+</gu, "><");

        const defaults = renderReply(text, Object.values(defaultRehypePlugins) as PluggableList);

        expect(blocks(renderReply(text))).toBe(blocks(defaults));
    });

    it("still sanitizes a reply with HTML: scripts and handlers go, allowed tags stay", () => {
        expect.assertions(5);

        const html = renderReply('Press <kbd>Ctrl</kbd> and <b onclick="steal()">this</b>.\n\n<script>alert(1)</script>\n\n<img src="x" onerror="steal()">');

        expect(html).toContain("<kbd>Ctrl</kbd>");
        expect(html).toContain("<b>this</b>");
        expect(html).not.toContain("<script");
        expect(html).not.toContain("onclick");
        expect(html).not.toContain("onerror");
    });
});
