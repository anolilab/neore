import { createDocument } from "@mixmark-io/domino";
import { afterEach, describe, expect, it } from "vitest";

import { setHTMLParser } from "../src/html-parser";
import TurndownService, { paste, PASTE_OPTIONS } from "../src/index";

/*
 * Numbering an ordered list must cost work in proportion to its length. Each item's number depends on the items before
 * it, so a rule that walks back over them for every item is quadratic. So is one that looks for a closed details'
 * summary once per child, or for the start of a Word list once per paragraph. The tests count the sibling steps taken
 * from the elements a selector picks, through the HTML parser hook: each of them gets counting getters.
 */

// A linear conversion steps from each item to a sibling a small, fixed number of times.
const STEPS_PER_ITEM = 10;

const steps = { count: 0 };

/** A prototype on an element's chain; only its own sibling accessors are read. */
type SiblingName = "nextElementSibling" | "nextSibling" | "parentElement" | "previousElementSibling" | "previousSibling";
type SiblingPrototype = Partial<Pick<Element, SiblingName>>;

const SIBLING_NAMES: ReadonlyArray<SiblingName> = ["nextElementSibling", "nextSibling", "parentElement", "previousElementSibling", "previousSibling"];

function getter(element: Element, name: SiblingName): (this: Element) => Node | null {
    let owner: SiblingPrototype | null = Object.getPrototypeOf(element) as SiblingPrototype;

    while (owner) {
        const found = Object.getOwnPropertyDescriptor(owner, name)?.get;

        if (found) {
            return found as (this: Element) => Node | null;
        }

        owner = Object.getPrototypeOf(owner) as SiblingPrototype | null;
    }

    throw new Error(`the parser's elements have no ${name} getter`);
}

/** A parser whose elements matching `selector` count each step to a sibling. */
function countingParser(selector: string): (html: string) => Document {
    return (html) => {
        const document = createDocument(html);

        countSteps(document, selector);

        return document;
    };
}

function countSteps(document: Document, selector: string): void {
    const found = document.querySelectorAll(selector);
    // Copied by index: domino's NodeList is not iterable.
    const items = Array.from({ length: found.length }, (_unused, index) => found[index] as Element);
    const first = items[0] as Element;

    for (const name of SIBLING_NAMES) {
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
}

afterEach(() => {
    setHTMLParser(createDocument);
});

function convert(html: string, selector: string): string {
    steps.count = 0;
    setHTMLParser(countingParser(selector));

    return new TurndownService(PASTE_OPTIONS).use(paste).turndown(html);
}

describe("paste: long ordered lists stay linear", () => {
    it.each([1000, 4000])("numbers a list of %i items stepping between items a linear number of times", (count) => {
        const markdown = convert(`<ol>${"<li>x</li>".repeat(count)}</ol>`, "li");

        expect(markdown.split("\n").at(-1)).toBe(`${count}. x`);
        expect(steps.count).toBeLessThan(STEPS_PER_ITEM * count);
    });

    it.each([1000, 4000])("places a Google Docs list of %i items stepping between items a linear number of times", (count) => {
        const markdown = convert(`<ol>${`<li aria-level="1">a</li><li aria-level="2">b</li>`.repeat(count / 2)}</ol>`, "li");

        // The last top item is numbered count / 2; its sub-item is indented to its text.
        expect(markdown.split("\n").at(-1)).toBe(`${" ".repeat(String(count / 2).length + 2)}1. b`);
        expect(steps.count).toBeLessThan(STEPS_PER_ITEM * count);
    });

    it.each([1000, 4000])("places a Word list of %i paragraphs stepping between them a linear number of times", (count) => {
        const item = `<p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">1.</span>x</p>`;
        const markdown = convert(item.repeat(count), "p");

        expect(markdown.split("\n")).toHaveLength(count);
        expect(steps.count).toBeLessThan(STEPS_PER_ITEM * count);
    });

    it.each([1000, 4000])("places %i lists placed straight in a list stepping between them a linear number of times", (count) => {
        const markdown = convert(`<ul><li>a</li>${"<ul><li>b</li></ul>".repeat(count)}</ul>`, "ul > ul");

        expect(markdown.split("\n").at(-1)).toBe("  - b");
        expect(steps.count).toBeLessThan(STEPS_PER_ITEM * count);
    });
});

describe("paste: a closed details stays linear", () => {
    it.each([
        ["no summary", ""],
        ["a summary at the end", "<summary>end</summary>"],
    ])("finds the summary of one with many children and %s once", (_name, summary) => {
        const count = 4000;
        const markdown = convert(`<details>${"<p>x</p>".repeat(count)}${summary}</details>`, "details > *");

        expect(markdown).toBe(summary === "" ? "" : "end");
        expect(steps.count).toBeLessThan(STEPS_PER_ITEM * count);
    });
});

describe("paste: a code block's language stays linear", () => {
    it("finds the shown code past many code elements under a deep hidden wrapper, stepping a linear number of times", () => {
        const count = 2000;
        const depth = 200;
        const hidden = `<div hidden>${"<span>".repeat(depth)}${"<code>x</code>".repeat(count)}${"</span>".repeat(depth)}</div>`;
        const markdown = convert(`<pre>${hidden}<code class="language-js">y</code></pre>`, "pre *");

        expect(markdown).toBe("```js\ny\n```");
        expect(steps.count).toBeLessThan(STEPS_PER_ITEM * (count + depth));
    });
});
