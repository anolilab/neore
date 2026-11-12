/* eslint-disable no-script-url -- the `javascript:` strings are link destinations converted to text, never requests */
import { readFileSync } from "node:fs";

import { createDocument } from "@mixmark-io/domino";
import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * Paste safety. A paste must not carry the text of non-content elements (scripts, style sheets, noscript fallbacks,
 * templates, titles), nor a link destination a browser would run when the option `safeLinks` is on. Upstream turndown
 * keeps the non-content text and every destination, so the non-content expectations here are deliberate divergences.
 */

const NON_CONTENT_CASES: [string, string][] = [
    ["script", "<script>alert(1)</script><p>a</p>"],
    ["style", "<style>p{color:red}</style><p>a</p>"],
    ["noscript", "<noscript><p>fallback</p></noscript><p>a</p>"],
    ["title", "<title>Doc title</title><p>a</p>"],
];

const UNSAFE_DESTINATIONS = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "\u{1}javascript:alert(1)",
    // Character references and backslash escapes: CommonMark decodes them in a destination, so the scheme is checked after that.
    "javascript&amp;#58;alert(1)",
    "javascript&amp;#x3a;alert(1)",
    "javascript&amp;colon;alert(1)",
    String.raw`javascript\:alert(1)`,
    "data:text/html,<p>hi</p>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.com/file",
];

const SAFE_DESTINATIONS = [
    "https://example.com/page",
    // eslint-disable-next-line unicorn/prefer-https -- http is an allowed scheme, so the test needs it
    "http://example.com/",
    "HTTPS://EXAMPLE.COM/",
    "mailto:someone@example.com",
    "tel:+15550100",
    "/docs/page",
    "#section",
    "//example.com/x",
    "page.html",
    "./a:b",
];

const anchor = (href: string): string => `<p><a href="${href}">x</a></p>`;

describe("non-content elements emit nothing", () => {
    for (const [name, html] of NON_CONTENT_CASES) {
        it(`drops the text of a ${name} from a string`, () => {
            expect(new TurndownService().turndown(html)).toBe("a");
        });

        it(`drops the text of a ${name} from a node`, () => {
            const div = createDocument(`<div>${html}</div>`).querySelector("div") as unknown as Node;

            expect(new TurndownService().turndown(div)).toBe("a");
        });
    }

    it("drops the text of a script between words without doubling the space", () => {
        expect(new TurndownService().turndown("<p>a <script>x()</script> b</p>")).toBe("a b");
    });

    // The HTML parser moves a template's children into `.content`, so a string input never has them as direct children.
    // This node is built in code, so the template's text is a direct child and only the removal can drop it.
    it("drops a template whose children are direct children of the template", () => {
        const document = createDocument("<div></div>");
        const div = document.querySelector("div") as HTMLElement;
        const template = document.createElement("template");
        const paragraph = document.createElement("p");

        /* eslint-disable unicorn/prefer-dom-node-append -- domino has no append(), so appendChild is the only way here */
        paragraph.appendChild(document.createTextNode("tpl"));
        template.appendChild(paragraph);
        div.appendChild(template);
        div.appendChild(document.createTextNode("a"));
        /* eslint-enable unicorn/prefer-dom-node-append */

        expect(new TurndownService().turndown(div as unknown as Node)).toBe("a");
    });

    // The Word wrapper leaves whitespace before the paragraph. Upstream keeps that too, so these tests trim only the
    // whitespace; the style text must still be absent.
    it("drops the Word style sheet from the Word paragraph fixture", () => {
        const html = readFileSync(new URL("../bench/fixtures/word-paragraph.html", import.meta.url), "utf8");

        expect(new TurndownService().turndown(html).trim()).toBe("The quarterly numbers are in, and the trend holds.");
    });

    it("drops the style sheet of a whole document node", () => {
        const html = readFileSync(new URL("../bench/fixtures/word-paragraph.html", import.meta.url), "utf8");

        expect(new TurndownService().turndown(createDocument(html) as unknown as Node).trim()).toBe("The quarterly numbers are in, and the trend holds.");
    });
});

describe("safeLinks", () => {
    it("keeps a javascript: destination by default, as upstream does", () => {
        expect(new TurndownService().turndown(anchor("javascript:alert(1)"))).toBe(String.raw`[x](javascript:alert\(1\))`);
    });

    it("keeps a query's & unescaped by default, as upstream does", () => {
        expect(new TurndownService().turndown(anchor("https://example.com/?a=1&b=2"))).toBe("[x](https://example.com/?a=1&b=2)");
    });

    it("escapes & in a safe destination so the rendered href keeps the query", () => {
        expect(new TurndownService({ safeLinks: true }).turndown(anchor("https://example.com/?a=1&b=2"))).toBe("[x](https://example.com/?a=1&amp;b=2)");
    });

    it("drops a relative destination with & before its first slash, query or fragment", () => {
        expect(new TurndownService({ safeLinks: true }).turndown(anchor("page&amp;x.html"))).toBe("x");
    });

    // Images are out of scope for safeLinks: an image does not run script, so its src is kept as it was before.
    it("keeps a javascript: image source with safeLinks, as the option does not cover images", () => {
        expect(new TurndownService({ safeLinks: true }).turndown(`<img src="javascript:alert(1)">`)).toBe(String.raw`![](javascript:alert\(1\))`);
    });

    it.each(UNSAFE_DESTINATIONS)("renders %j as its text only", (href) => {
        expect(new TurndownService({ safeLinks: true }).turndown(anchor(href))).toBe("x");
    });

    it.each(SAFE_DESTINATIONS)("keeps %j as the destination", (href) => {
        expect(new TurndownService({ safeLinks: true }).turndown(anchor(href))).toBe(`[x](${href})`);
    });

    it("renders an unsafe destination as its text only from a node", () => {
        const node = createDocument(anchor("javascript:alert(1)")).querySelector("p") as unknown as Node;

        expect(new TurndownService({ safeLinks: true }).turndown(node)).toBe("x");
    });

    it("renders an unsafe destination as its text only with reference-style links", () => {
        const service = new TurndownService({ linkStyle: "referenced", safeLinks: true });

        expect(service.turndown(anchor("javascript:alert(1)"))).toBe("x");
    });

    it("keeps a safe destination as a reference with reference-style links", () => {
        const service = new TurndownService({ linkStyle: "referenced", safeLinks: true });

        expect(service.turndown(anchor("https://example.com/page"))).toBe("[x][1]\n\n[1]: https://example.com/page");
    });

    // A line break in a destination would start a second reference definition, which would take over the next anchor's [2].
    it("keeps a line break out of a reference destination, so a second definition cannot be written", () => {
        const service = new TurndownService({ linkStyle: "referenced", safeLinks: true });
        const html = `<p><a href="https://ok\n[2]: javascript:alert(1)">a</a> <a href="https://legit.example/">b</a></p>`;

        expect(service.turndown(html)).toBe("[a][1] [b][2]\n\n[1]: <https://ok[2]: javascript:alert\\(1\\)>\n[2]: https://legit.example/");
    });
});
