/*
 * The seeded generator is a 32-bit PRNG (bit operations are its algorithm), and the
 * URLs and HTML below are inputs to convert, never requests.
 */
/* eslint-disable no-bitwise, operator-assignment, unicorn/operator-assignment, unicorn/prefer-math-trunc, no-script-url -- see the comment above */
import { createDocument } from "@mixmark-io/domino";
import TurndownUpstream from "turndown";
import { describe, expect, it } from "vitest";

import type { Options } from "../src/index";
import TurndownService from "../src/index";

/*
 * Differential check against upstream turndown 7.2.5 on seeded random HTML.
 * Several regular expressions were replaced by linear scans (edge whitespace,
 * code padding, attribute line breaks, trailing whitespace); this test is the
 * evidence that the output did not change.
 */

const SEED = 20_261_112;
const CASES = 1500;
const NON_BLANK = /\S/;

// Mulberry32: a small seeded PRNG, so a failure reproduces exactly.
function createRandom(seed: number): () => number {
    let state = seed;

    return () => {
        state = (state + 1_831_565_813) | 0;

        let value = Math.imul(state ^ (state >>> 15), 1 | state);

        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;

        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
}

const TEXT_PIECES = [
    "a",
    "b c",
    " ",
    "  ",
    "\n",
    "\n\n",
    "\t",
    " ",
    "   ",
    "*",
    "_",
    "`",
    "``",
    "[",
    "]",
    "\\",
    "#",
    "-",
    "+ ",
    "1. ",
    ">",
    "=",
    "~~~",
    "<",
    "&amp;",
    "\u{2028}",
    "\u{2029}",
    "x_y",
    "snake_case",
    "word ",
    "\r\n",
    "  \n  ",
    "(",
    ")",
    `"`,
];

const ELEMENTS = [
    "p",
    "div",
    "span",
    "em",
    "strong",
    "b",
    "i",
    "code",
    "pre",
    "a",
    "h1",
    "h2",
    "h3",
    "ul",
    "ol",
    "li",
    "blockquote",
    "del",
    "sup",
    "section",
    "table",
    "tr",
    "td",
    "th",
    "figure",
    "iframe",
];

// `script` is not generated: the port drops its text where upstream keeps it, a deliberate divergence covered by
// test/paste-safety.test.ts. The `javascript:` href is kept by default (`safeLinks` is off), as upstream keeps it.
const HREFS = ["https://x.y/z", "a b", "(x)", "<y>", "", "javascript:alert(1)"];
const TITLES = ["", `a "quoted" title`, "line\nbreak\n\n  title"];
const VOID_ELEMENTS = ["<br>", "<hr>", `<img alt="a_b" src="i.png">`, `<img src="">`];

function pick<T>(items: ReadonlyArray<T>, random: () => number): T {
    return items[Math.floor(random() * items.length)] as T;
}

function randomHtml(random: () => number, depth: number): string {
    if (depth > 3 || random() < 0.35) {
        return pick(TEXT_PIECES, random);
    }

    if (random() < 0.06) {
        return pick(VOID_ELEMENTS, random);
    }

    const tag = pick(ELEMENTS, random);
    let attributes = "";

    switch (tag) {
        case "a": {
            attributes = ` href="${pick(HREFS, random)}" title="${pick(TITLES, random)}"`;

            break;
        }
        case "code": {
            attributes = ` class="${pick(["language-js", "", "x language-ts y"], random)}"`;

            break;
        }
        case "ol": {
            attributes = ` start="${pick(["", "3", "7"], random)}"`;

            break;
        }
        default: {
            break;
        }
    }

    const childCount = Math.floor(random() * 4);
    let inner = "";

    for (let index = 0; index < childCount; index += 1) {
        inner += randomHtml(random, depth + 1);
    }

    return `<${tag}${attributes}>${inner}</${tag}>`;
}

const OPTION_SETS: Partial<Options>[] = [
    {},
    { headingStyle: "atx" },
    { codeBlockStyle: "fenced" },
    { codeBlockStyle: "fenced", fence: "~~~" },
    { linkStyle: "referenced" },
    { linkReferenceStyle: "collapsed", linkStyle: "referenced" },
    { linkReferenceStyle: "shortcut", linkStyle: "referenced" },
    { preformattedCode: true },
    { br: "\\", bulletListMarker: "-", emDelimiter: "*", hr: "---", strongDelimiter: "__" },
];

/*
 * #554: text after a nested list that ends an item. The output differs from upstream
 * on purpose (a blank line keeps the text out of the sub-item), so such documents are
 * skipped here and covered by lists-code.test.ts. Non-numeric `start` values (#547)
 * are no longer generated for the same reason; lists-code.test.ts covers them.
 */
function hasTextAfterNestedList(html: string): boolean {
    const parsed = createDocument(html);

    return Array.from(parsed.querySelectorAll("li"), (item) => hasTrailingListThenText(item)).includes(true);
}

function hasTrailingListThenText(item: Element): boolean {
    let lastElement: Element | null = null;
    let hasTextAfterLast = false;

    for (let child = item.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1) {
            lastElement = child as Element;
            hasTextAfterLast = false;
        } else if (child.nodeType === 3 && NON_BLANK.test(child.nodeValue ?? "")) {
            hasTextAfterLast = true;
        }
    }

    return hasTextAfterLast && (lastElement?.nodeName === "UL" || lastElement?.nodeName === "OL");
}

describe("differential against upstream turndown 7.2.5", () => {
    it(`matches upstream on ${CASES} seeded random documents`, () => {
        const random = createRandom(SEED);
        let skipped = 0;

        for (let index = 0; index < CASES; index += 1) {
            const html = randomHtml(random, 0) + randomHtml(random, 0);

            if (hasTextAfterNestedList(html)) {
                skipped += 1;

                continue;
            }

            const options = pick(OPTION_SETS, random);

            const expected = new TurndownUpstream(options).turndown(html);
            const actual = new TurndownService(options).turndown(html);

            if (actual !== expected) {
                expect.fail(
                    `case ${index} differs for ${JSON.stringify(options)}\ninput: ${JSON.stringify(html)}\nupstream: ${JSON.stringify(expected)}\nours:     ${JSON.stringify(actual)}`,
                );
            }
        }

        expect(skipped).toBeLessThan(CASES / 100);
    });
});
