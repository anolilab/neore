import { createDocument } from "@mixmark-io/domino";
import { afterEach, describe, expect, it, vi } from "vitest";

import TurndownService, { setHTMLParser } from "../src/index";

const CASES = [
    "<p>a <em>b</em> <a href='https://example.com'>c</a></p>",
    "<ul><li>one</li><li>two</li></ul>",
    "<table><tr><td>x</td></tr></table>",
    "<p>a <script>x()</script> b</p>",
    "<pre><code>let x = 1;</code></pre>",
];

const NO_PARSER_ERROR = /^@neore\/html-to-markdown: no HTML parser\..*setHTMLParser/;

afterEach(() => {
    vi.unstubAllGlobals();
    setHTMLParser(createDocument);
});

describe("HTML parser", () => {
    it("throws an Error that names setHTMLParser when there is no parser and no DOMParser", () => {
        vi.stubGlobal("DOMParser", undefined);
        setHTMLParser(undefined);

        expect(() => new TurndownService().turndown("<p>a</p>")).toThrowError(NO_PARSER_ERROR);
    });

    it("gives the same output with a supplied parser as with DOMParser", () => {
        const parseFromString = vi.fn((html: string): Document => createDocument(html));

        class DOMParserStub {
            readonly parseFromString = parseFromString;
        }

        vi.stubGlobal("DOMParser", DOMParserStub);
        setHTMLParser(undefined);
        const withDOMParser = CASES.map((html) => new TurndownService().turndown(html));

        const supplied = vi.fn((html: string): Document => createDocument(html));

        setHTMLParser(supplied);
        const withSupplied = CASES.map((html) => new TurndownService().turndown(html));

        expect(parseFromString).toHaveBeenCalledTimes(CASES.length);
        expect(supplied).toHaveBeenCalledTimes(CASES.length);
        expect(withSupplied).toEqual(withDOMParser);
    });
});
