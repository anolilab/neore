import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * A custom rule replaces an element's output, so the DOM children of that element say nothing about the
 * text it writes. Emphasis next to it must not choose a delimiter that depends on those children.
 */

describe("emphasis beside a custom-rendered element", () => {
    it("uses the asterisk when the neighbour's custom output starts with a word character", () => {
        const service = new TurndownService();

        service.addRule("span", { filter: "span", replacement: () => "a" });

        expect(service.turndown("<em>x</em><span>!</span>")).toBe("*x*a");
    });
});
