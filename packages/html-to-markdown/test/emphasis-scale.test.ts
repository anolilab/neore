import { createDocument } from "@mixmark-io/domino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setHTMLParser } from "../src/html-parser";
import TurndownService from "../src/index";

/*
 * Long runs of emphasis must cost work in proportion to their length. Reading an element's text walks its whole
 * subtree, which is the costly step, so the test adds up the characters every element text read returns rather
 * than measuring time. Reading a long parent's text once per child makes that total quadratic in the run length.
 * The reads are counted through the HTML parser hook: each parsed element gets its own counting getter.
 */

// A linear conversion reads each character a small, fixed number of times.
const READS_PER_CHARACTER = 40;

const reads = { characters: 0 };

/** A prototype on an element's chain; only its own textContent accessor is read. */
type TextPrototype = Partial<Pick<Node, "textContent">>;

function textContentGetter(element: Element): (this: Node) => string | null {
    let owner: TextPrototype | null = Object.getPrototypeOf(element) as TextPrototype;

    while (owner) {
        const getter = Object.getOwnPropertyDescriptor(owner, "textContent")?.get;

        if (getter) {
            return getter as (this: Node) => string | null;
        }

        owner = Object.getPrototypeOf(owner) as TextPrototype | null;
    }

    throw new Error("the parser's elements have no textContent getter");
}

function countingParser(html: string): Document {
    const document = createDocument(html);
    const elements = [...document.querySelectorAll("*")];
    const read = textContentGetter(elements[0] as Element);

    for (const element of elements) {
        Object.defineProperty(element, "textContent", {
            configurable: true,
            get: () => {
                const text = read.call(element);

                reads.characters += text?.length ?? 0;

                return text;
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

function convertCountingReads(html: string): { output: string; reads: number } {
    reads.characters = 0;

    const output = new TurndownService().turndown(html);

    return { output, reads: reads.characters };
}

describe("long emphasis runs stay linear", () => {
    it.each([1000, 4000])("reads the text of a run of %i adjacent elements in work linear in its length", (count) => {
        const result = convertCountingReads("<em>x</em>".repeat(count));

        expect(result.output).toBe(`_${"x".repeat(count)}_`);
        expect(result.reads).toBeLessThan(READS_PER_CHARACTER * count);
    });

    it.each([1000, 4000])("reads the text of a same-kind parent with %i children in work linear in its length", (count) => {
        const result = convertCountingReads(`<em>${"<em>x</em>".repeat(count)}</em>`);

        expect(result.output).toBe(`_${"x".repeat(count)}_`);
        expect(result.reads).toBeLessThan(READS_PER_CHARACTER * count);
    });
});
