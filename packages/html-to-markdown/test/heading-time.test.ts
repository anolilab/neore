import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * A heading with many breaks and a block. Every break asks for its heading's break mark, which is computed once per
 * heading. A break that recomputed it serialised the whole heading each time, so a long heading took quadratic time.
 */

describe("a heading with many breaks and a block", () => {
    it("converts 8,000 breaks well inside the time a quadratic conversion would take", () => {
        const started = performance.now();
        const markdown = new TurndownService({ br: "\n", headingStyle: "atx" }).turndown(`<h1>${"a<br>".repeat(8000)}<div>c</div></h1>`);
        const elapsed = performance.now() - started;

        expect(markdown.endsWith("\n\nc")).toBe(true);
        expect(elapsed).toBeLessThan(8000);
    });
});
