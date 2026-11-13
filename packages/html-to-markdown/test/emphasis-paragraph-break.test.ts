import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * With `br: "\n"` a hard break is written as a blank line, which is a paragraph boundary. Emphasis cannot span a
 * paragraph boundary, so two emphasis elements on either side of one break must each close their own delimiters.
 */

describe("emphasis across a break that writes a blank line", () => {
    it.each([
        ["a trailing break", "<em>a<br></em><em>b</em>", "_a_\n\n_b_"],
        ["a leading break", "<em>a</em><em><br>b</em>", "_a_\n\n_b_"],
        ["strong text", "<strong>a<br></strong><strong>b</strong>", "**a**\n\n**b**"],
    ])("closes each run at %s", (_name, html, expected) => {
        expect(new TurndownService({ br: "\n" }).turndown(html)).toBe(expected);
    });

    it("still joins the two across one break when the break stays in the paragraph", () => {
        expect(new TurndownService().turndown("<em>a<br></em><em>b</em>")).toBe("_a  \nb_");
    });
});
