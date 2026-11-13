import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * Two emphasis elements around a break, with something that prints nothing (a comment, an empty span) between
 * them. Each member walks toward the other, so both walks must skip what prints nothing, or they disagree about
 * the run and one delimiter is left without its partner.
 */

describe("emphasis around a break with a non-printing node between", () => {
    it.each([
        ["a trailing break, then a comment", "<em>a<br></em><!-- --><em>b</em>"],
        ["a comment, then a leading break", "<em>a</em><!-- --><em><br>b</em>"],
        ["a trailing break, then an empty span", "<em>a<br></em><span></span><em>b</em>"],
    ])("%s gives the same output as with nothing between", (_name, html) => {
        const plain = html.replace("<!-- -->", "").replace("<span></span>", "");

        expect(new TurndownService().turndown(html)).toBe(new TurndownService().turndown(plain));
    });
});
