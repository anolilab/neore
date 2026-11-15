import { afterEach, describe, expect, it, vi } from "vitest";

import TurndownService, { paste, PASTE_OPTIONS } from "../src/index";

/*
 * A code block of many line elements must cost work in proportion to its length. Joining the parts built so far once
 * per line, to look at the end of the text, is quadratic. The test adds up the characters every array join returns
 * rather than measuring time: a linear conversion joins each character a small, fixed number of times.
 */

const JOINS_PER_CHARACTER = 10;

afterEach(() => {
    vi.restoreAllMocks();
});

/** The Markdown for `html`, and the characters every array join produced while converting it. */
function convertCountingJoins(html: string): { joined: number; output: string } {
    const { join } = Array.prototype;
    let joined = 0;

    vi.spyOn(Array.prototype, "join").mockImplementation(function joinCounting(this: unknown[], separator?: string): string {
        // eslint-disable-next-line unicorn/no-this-outside-of-class -- a replacement for a prototype method reads its array through `this`.
        const text = join.call(this, separator);

        joined += text.length;

        return text;
    });

    const output = new TurndownService(PASTE_OPTIONS).use(paste).turndown(html);

    return { joined, output };
}

describe("a code block of many line elements stays linear", () => {
    it.each([2000, 8000])("joins the text of %i line elements in work linear in its length", (count) => {
        const result = convertCountingJoins(`<pre>${"<div>let a = 1;</div>".repeat(count)}</pre>`);

        expect(result.output.split("\n").filter((line) => line === "let a = 1;")).toHaveLength(count);
        expect(result.joined).toBeLessThan(JOINS_PER_CHARACTER * result.output.length);
    });
});
