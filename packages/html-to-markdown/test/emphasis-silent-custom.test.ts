import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * An element that a custom, keep or remove rule claims but that prints nothing must not split an emphasis run:
 * an empty element goes through the blank rule whatever its filter says, and a removed element writes nothing.
 */

describe("an element that a rule claims but that prints nothing, between emphasis", () => {
    const plain = new TurndownService().turndown("<em>a</em><em>b</em>");

    it("joins the run across an empty span that a custom rule claims", () => {
        const service = new TurndownService();

        service.addRule("span", { filter: "span", replacement: (content: string) => `[${content}]` });

        expect(service.turndown("<em>a</em><span></span><em>b</em>")).toBe(plain);
    });

    it("joins the run across an empty span that a keep rule claims", () => {
        const service = new TurndownService();

        service.keep("span");

        expect(service.turndown("<em>a</em><span></span><em>b</em>")).toBe(plain);
    });

    it("joins the run across a span that a remove rule drops", () => {
        const service = new TurndownService();

        service.remove("span");

        expect(service.turndown("<em>a</em><span>x</span><em>b</em>")).toBe(plain);
    });

    it("still splits the run at a custom rule that prints text", () => {
        const service = new TurndownService();

        service.addRule("span", { filter: "span", replacement: () => "x" });

        expect(service.turndown("<em>a</em><span>y</span><em>b</em>")).toBe("*a*x*b*");
    });
});
