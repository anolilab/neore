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
    ["template", "<template><p>tpl</p></template><p>a</p>"],
    ["title", "<title>Doc title</title><p>a</p>"],
];

const UNSAFE_DESTINATIONS = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "\u{1}javascript:alert(1)",
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
});
