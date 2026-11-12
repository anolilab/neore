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
import rootNode from "../src/root-node";
import { hasVoidOrMeaningfulDescendant, isBlock, isMeaningfulWhenBlank, isVoid } from "../src/utilities";

/*
 * Differential check against upstream turndown 7.2.5 on seeded random HTML.
 * Several regular expressions were replaced by linear scans (edge whitespace,
 * code padding, attribute line breaks, trailing whitespace); this test is the
 * evidence that the output did not change.
 *
 * Some fixes change output on purpose, so the comparison is exact only for inputs that
 * avoid them. The generator avoids two of them: a `<` or a bare number that ends a text
 * node (the `< x` and `1. x` pieces end in a letter, since block-end and `<br>` trimming
 * would otherwise strip the space after the `<` or the number), and block elements and
 * `<hr>` inside a link (link content uses inline elements only). It does not avoid a
 * line break inside link text, which now becomes a space. For example,
 * `<pre><a href="/x">one\ntwo</a></pre>` gives `[one\ntwo](/x)` upstream and
 * `[one two](/x)` here. The first 1,500 cases contain no such input, so they match
 * exactly. With 20,000 cases from the same seed, 8 differ, all of this kind; the seed
 * and count are kept so the test stays stable. escaping-links.test.ts covers the fixes.
 */

const SEED = 20_261_112;
const CASES = 1500;
const NON_BLANK = /\S/;

const EMPHASIS_NAMES = new Set(["B", "EM", "I", "STRONG"]);
const BREAK_IN_CODE_OR_HEADING = "pre br, code br, h1 br, h2 br, h3 br, h4 br, h5 br, h6 br";
const EMPHASIS_KIND = new Map([
    ["B", "strong"],
    ["EM", "em"],
    ["I", "em"],
    ["STRONG", "strong"],
]);
const WORD_CHARACTER = /^[^\s\p{P}\p{S}]$/u;
const NO_WORD_EDGE = new Set(["A", "CODE"]);
const SIDES = ["previousSibling", "nextSibling"] as const;
const BLANK_TEXT = /^\s*$/;
const EDGE_WHITESPACE = /^\s|\s$/;

/*
 * True for a document whose output is meant to differ from upstream. Each case is one of
 * the changes pinned in test/inline-breaks.test.ts: a break inside code or a heading; a
 * break at the edge of emphasis (or of an element whose text is trimmed); emphasis next to
 * other emphasis, which merges into a run; emphasis that touches a word character, which
 * uses `*`; and emphasis nested directly in the same kind inside a parent with no printing
 * block, which writes no delimiters. Every other document must match upstream.
 */
function isChangedOnPurpose(html: string, options: Partial<Options>): boolean {
    // The converter's own DOM, with whitespace collapsed, so the checks see the same text it does.
    const root = rootNode(html, new TurndownService(options).options) as Element;

    if (root.querySelector(BREAK_IN_CODE_OR_HEADING)) {
        return true;
    }

    for (const element of root.querySelectorAll("*")) {
        // An edge break changes output inside emphasis, and inside any element whose text is
        // trimmed (it has whitespace at an edge). Elsewhere it is written as upstream writes it.
        if ((EMPHASIS_NAMES.has(element.nodeName) || hasEdgeSpace(element)) && hasEdgeBreak(element)) {
            return true;
        }

        // A blank emphasis element writes nothing; a block inside it still writes a separator, so it is not blank.
        if (EMPHASIS_NAMES.has(element.nodeName) && !isBlankElement(element) && isNestedInSameKind(element)) {
            return true;
        }

        // A run that touches another emphasis element or a word changes output; an empty one has no run to change.
        if (EMPHASIS_NAMES.has(element.nodeName) && element.textContent !== "" && hasChangedNeighbour(element)) {
            return true;
        }
    }

    return false;
}

function isEmptyNode(node: Node): boolean {
    return node.nodeName !== "BR" && (node.textContent ?? "") === "";
}

function nearest(node: Node, side: (typeof SIDES)[number]): Node | null {
    let sibling = node[side];

    while (sibling && isEmptyNode(sibling)) {
        sibling = sibling[side];
    }

    return sibling;
}

/**
 * An inline element with no text and no break. The converter looks past it at an edge
 * (`edgeBreaks` in src/utilities.ts counts through it), so the edge test must too.
 */
function isEmptyInline(node: ChildNode): boolean {
    return node.nodeType === 1 && !isBlock(node) && !isVoid(node) && BLANK_TEXT.test(node.textContent ?? "") && !(node as Element).querySelector("br");
}

/** True when a break is the first or last thing in the element, looking through nested elements. */
function hasEdgeBreak(element: Element): boolean {
    const children = [...element.childNodes].filter((child) => !(child.nodeType === 3 && BLANK_TEXT.test(child.nodeValue ?? "")) && !isEmptyInline(child));
    const first = children[0];
    const last = children.at(-1);

    const isBreak = (child: ChildNode | undefined): boolean => child?.nodeName === "BR" || (child?.nodeType === 1 && hasEdgeBreak(child as Element));

    return isBreak(first) || isBreak(last);
}

/**
 * True when the element's direct parent is emphasis of the same kind and has no printing block
 * inside, so the nested one writes no delimiters. A parent with a printing block keeps its
 * delimiters, so the nested element matches upstream there.
 */
function isNestedInSameKind(element: Element): boolean {
    const parent = element.parentElement;

    return parent !== null && EMPHASIS_KIND.get(parent.nodeName) === EMPHASIS_KIND.get(element.nodeName) && !hasPrintingBlockDescendant(parent);
}

/**
 * True when a block sits inside the element, at any depth, mirroring `hasPrintingBlockDescendant`
 * in src/commonmark-rules.ts: a blank block counts, and a blank non-block element is skipped with its contents.
 */
function hasPrintingBlockDescendant(element: Element): boolean {
    return [...element.childNodes].some((node) => {
        if (node.nodeType !== 1) {
            return false;
        }

        const child = node as Element;

        return isBlock(child) || (!isBlankElement(child) && hasPrintingBlockDescendant(child));
    });
}

/** The converter's blank test (`isBlank` in src/node.ts): only whitespace text, and no void or meaningful element. */
function isBlankElement(element: Element): boolean {
    if (isVoid(element) || isMeaningfulWhenBlank(element)) {
        return false;
    }

    return BLANK_TEXT.test(element.textContent ?? "") && !hasVoidOrMeaningfulDescendant(element);
}

function hasEdgeSpace(element: Element): boolean {
    return EDGE_WHITESPACE.test(element.textContent ?? "");
}

function hasChangedNeighbour(element: Element): boolean {
    return SIDES.some((side) => {
        const next = nearest(element, side);
        // Adjacent emphasis, with at most one break between, merges into one run.
        const afterBreak = next?.nodeName === "BR" ? nearest(next, side) : next;

        return Boolean(afterBreak && EMPHASIS_NAMES.has(afterBreak.nodeName)) || isWordNeighbour(next, side);
    });
}

/**
 * True when the sibling's facing character is a word character, which makes the emphasis
 * intraword. A break is not a word, and a block, a void element, a link or code shows a
 * delimiter or a boundary there, never a word character.
 */
function isWordNeighbour(sibling: Node | null, side: (typeof SIDES)[number]): boolean {
    if (!sibling || sibling.nodeName === "BR" || isBlock(sibling) || isVoid(sibling) || NO_WORD_EDGE.has(sibling.nodeName)) {
        return false;
    }

    const text = sibling.textContent ?? "";
    const characters = [...text];
    const facing = side === "previousSibling" ? characters.at(-1) : characters.at(0);

    return facing !== undefined && WORD_CHARACTER.test(facing);
}

// Measured: 1403 of the 1500 documents are compared. A blank block counts as a printing block
// in the predicate too, so a parent with one keeps its delimiters and is compared like upstream.
// The floor is that count, so an exclusion that grows (a regression hidden as an intended
// change) fails the test.
const MIN_COMPARED = 1403;

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
    "1. x",
    ">",
    "=",
    "~~~",
    "< x",
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

// Inside a link, `<hr>` and the block elements are left out (see the note at the top).
// Inside `script` and `iframe` the content is raw text, so only text is generated there.
const BLOCK_ELEMENTS = new Set(["blockquote", "div", "figure", "h1", "h2", "h3", "li", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul"]);
const INLINE_ELEMENTS = ELEMENTS.filter((tag) => !BLOCK_ELEMENTS.has(tag));
const INLINE_VOID_ELEMENTS = VOID_ELEMENTS.filter((element) => element !== "<hr>");
const RAW_TEXT_ELEMENTS = new Set(["iframe", "script"]);

type Context = "flow" | "link" | "raw";

function pick<T>(items: ReadonlyArray<T>, random: () => number): T {
    return items[Math.floor(random() * items.length)] as T;
}

function randomHtml(random: () => number, depth: number, context: Context = "flow"): string {
    if (context === "raw" || depth > 3 || random() < 0.35) {
        return pick(TEXT_PIECES, random);
    }

    if (random() < 0.06) {
        return pick(context === "link" ? INLINE_VOID_ELEMENTS : VOID_ELEMENTS, random);
    }

    const tag = pick(context === "link" ? INLINE_ELEMENTS : ELEMENTS, random);
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

    let childContext: Context = context;

    if (tag === "a") {
        childContext = "link";
    } else if (RAW_TEXT_ELEMENTS.has(tag)) {
        childContext = "raw";
    }

    const childCount = Math.floor(random() * 4);
    let inner = "";

    for (let index = 0; index < childCount; index += 1) {
        inner += randomHtml(random, depth + 1, childContext);
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
        let compared = 0;

        for (let index = 0; index < CASES; index += 1) {
            const html = randomHtml(random, 0) + randomHtml(random, 0);

            if (hasTextAfterNestedList(html)) {
                skipped += 1;

                continue;
            }

            const options = pick(OPTION_SETS, random);

            if (!isChangedOnPurpose(html, options)) {
                compared += 1;

                const expected = new TurndownUpstream(options).turndown(html);
                const actual = new TurndownService(options).turndown(html);

                if (actual !== expected) {
                    expect.fail(
                        `case ${index} differs for ${JSON.stringify(options)}\ninput: ${JSON.stringify(html)}\nupstream: ${JSON.stringify(expected)}\nours:     ${JSON.stringify(actual)}`,
                    );
                }
            }
        }

        expect(skipped).toBeLessThan(CASES / 100);
        expect(compared).toBeGreaterThanOrEqual(MIN_COMPARED);
    });
});
