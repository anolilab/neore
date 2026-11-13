import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * Emphasis runs. Adjacent `em`/`i` (or `strong`/`b`) elements share one set of delimiters, so the
 * run must be made only of elements that the built-in rule renders and that print something.
 */

describe("emphasis run members", () => {
    it("merges adjacent built-in emphasis into one run", () => {
        expect(new TurndownService().turndown("<i>1</i><em>2</em>")).toBe("_12_");
    });

    it.each([
        ["an image with no source", "<em><img alt=x></em><em>b</em>", "_b_"],
        ["a word-break hint", "<em>a</em><i><wbr></i>", "_a_"],
    ])("an element that prints nothing (%s) does not leave a delimiter out of its neighbour", (_name, html, expected) => {
        expect(new TurndownService().turndown(html)).toBe(expected);
    });

    it("an element that a custom rule renders is not a run member, so its neighbours keep their delimiters", () => {
        const service = new TurndownService();

        service.addRule("customI", { filter: "i", replacement: (content: string) => `[${content}]` });

        // The neighbours of a custom rule use the asterisk, which is valid next to any character.
        expect(service.turndown("<em>a</em><i>b</i><em>c</em>")).toBe("*a*[b]*c*");
    });

    it("a built-in element nested in a custom-rendered element keeps its own delimiters", () => {
        const service = new TurndownService();

        service.addRule("customEm", {
            filter(node: Node) {
                return node.nodeName === "EM" && (node as Element).getAttribute("class") === "x";
            },
            replacement: (content: string) => `{${content}}`,
        });

        expect(service.turndown("<em class=x>a<em>b</em></em>")).toBe("{a*b*}");
    });
});
