import { createDocument } from "@mixmark-io/domino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setHTMLParser } from "../src/html-parser";
import TurndownService from "../src/index";

/*
 * Deciding whether a `<` at the end of a text node is escaped reads the text after it, across nodes. That read must
 * stop at the first character that decides, so deeply nested text costs work in proportion to its depth. The test
 * counts the reads of text node values through the HTML parser hook: each parsed text node gets a counting getter.
 */

// Each level is a `<` text followed by a span that holds the next level. A linear conversion reads each level's text a
// small, fixed number of times; reading on to the end of the nesting from every level is quadratic in the depth.
const READS_PER_LEVEL = 20;

const reads = { count: 0 };

/** A prototype on a text node's chain; only its own nodeValue accessor is read. */
type ValuePrototype = Partial<Pick<Node, "nodeValue">>;

function nodeValueGetter(node: Node): (this: Node) => string | null {
    let owner: ValuePrototype | null = Object.getPrototypeOf(node) as ValuePrototype;

    while (owner) {
        const getter = Object.getOwnPropertyDescriptor(owner, "nodeValue")?.get;

        if (getter) {
            return getter as (this: Node) => string | null;
        }

        owner = Object.getPrototypeOf(owner) as ValuePrototype | null;
    }

    throw new Error("the parser's text nodes have no nodeValue getter");
}

function textNodes(node: Node, found: Node[]): Node[] {
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
            found.push(child);
        } else {
            textNodes(child, found);
        }
    }

    return found;
}

function countingParser(html: string): Document {
    const document = createDocument(html);
    const nodes = textNodes(document, []);
    const read = nodeValueGetter(nodes[0] as Node);

    for (const node of nodes) {
        Object.defineProperty(node, "nodeValue", {
            configurable: true,
            get: () => {
                reads.count += 1;

                return read.call(node);
            },
        });
    }

    return document;
}

beforeEach(() => {
    setHTMLParser(countingParser);
});

afterEach(() => {
    setHTMLParser(createDocument);
});

function nestedLessThan(depth: number): string {
    let html = "x";

    for (let level = 0; level < depth; level += 1) {
        html = `<span>&lt;${html}</span>`;
    }

    return html;
}

describe("deeply nested text after a <", () => {
    it.each([250, 500])("reads the text after each < in work linear in the depth at depth %i", (depth) => {
        reads.count = 0;

        const output = new TurndownService().turndown(nestedLessThan(depth));

        // The innermost `<` is followed by the letter `x`, which it would open raw HTML before, so it is escaped.
        expect(output).toBe(String.raw`${"<".repeat(depth - 1)}\<x`);
        expect(reads.count).toBeGreaterThanOrEqual(depth);
        expect(reads.count).toBeLessThan(READS_PER_LEVEL * depth);
    });
});
