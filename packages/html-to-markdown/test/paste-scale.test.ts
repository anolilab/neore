import { createDocument } from "@mixmark-io/domino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setHTMLParser } from "../src/html-parser";
import TurndownService, { paste, PASTE_OPTIONS } from "../src/index";

/*
 * Numbering an ordered list must cost work in proportion to its length. Each item's number depends on the items before
 * it, so a rule that walks back over them for every item is quadratic. The test counts the sibling steps taken from
 * list items through the HTML parser hook: each parsed item gets counting getters.
 */

// A linear conversion steps from each item to a sibling a small, fixed number of times.
const STEPS_PER_ITEM = 10;

const steps = { count: 0 };

/** A prototype on an element's chain; only its own sibling accessors are read. */
type SiblingPrototype = Partial<Pick<Element, "nextElementSibling" | "previousElementSibling">>;

function getter(element: Element, name: "nextElementSibling" | "previousElementSibling"): (this: Element) => Element | null {
    let owner: SiblingPrototype | null = Object.getPrototypeOf(element) as SiblingPrototype;

    while (owner) {
        const found = Object.getOwnPropertyDescriptor(owner, name)?.get;

        if (found) {
            return found as (this: Element) => Element | null;
        }

        owner = Object.getPrototypeOf(owner) as SiblingPrototype | null;
    }

    throw new Error(`the parser's elements have no ${name} getter`);
}

function countingParser(html: string): Document {
    const document = createDocument(html);
    const found = document.querySelectorAll("li");
    // Copied by index: domino's NodeList is not iterable.
    const items = Array.from({ length: found.length }, (_unused, index) => found[index] as Element);
    const first = items[0] as Element;

    for (const name of ["nextElementSibling", "previousElementSibling"] as const) {
        const read = getter(first, name);

        for (const item of items) {
            Object.defineProperty(item, name, {
                configurable: true,
                get: () => {
                    steps.count += 1;

                    return read.call(item);
                },
            });
        }
    }

    return document;
}

beforeEach(() => {
    setHTMLParser(countingParser);
});

afterEach(() => {
    setHTMLParser(createDocument);
});

describe("paste: long ordered lists stay linear", () => {
    it.each([1000, 4000])("numbers a list of %i items stepping between items a linear number of times", (count) => {
        steps.count = 0;

        const markdown = new TurndownService(PASTE_OPTIONS).use(paste).turndown(`<ol>${"<li>x</li>".repeat(count)}</ol>`);

        expect(markdown.split("\n").at(-1)).toBe(`${count}. x`);
        expect(steps.count).toBeLessThan(STEPS_PER_ITEM * count);
    });
});
