import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

describe("keep with safeLinks does not emit an unsafe link destination (PR #723 review)", () => {
    it("a kept anchor with a javascript: href is written as its text", () => {
        const service = new TurndownService({ safeLinks: true });

        service.keep(["a"]);
        expect(service.turndown(`<a href="javascript:alert(1)">x</a>`)).toBe("x");
    });

    it.each([
        ["a block keeps its unsafe anchor as text", ["p"], `<p><a href="javascript:alert(1)">x</a></p>`, "<p>x</p>"],
        ["an unsafe anchor deeper in a kept block", ["p"], `<p><span><a href="javascript:alert(1)">x</a></span></p>`, "<p><span>x</span></p>"],
        [
            "an unsafe anchor inside built-in markup in a kept inline",
            ["span"],
            `<p>a <span><b><a href="javascript:alert(1)">x</a></b></span></p>`,
            "a <span><b>x</b></span>",
        ],
        [
            "an SVG link with xlink:href is unwrapped too",
            ["svg"],
            `<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`,
            "<svg><text>x</text></svg>",
        ],
    ])("%s", (_name, kept, html, expected) => {
        const service = new TurndownService({ safeLinks: true });

        service.keep(kept);
        expect(service.turndown(html)).toBe(expected);
    });

    it("a safe anchor beside an unsafe one in a kept block keeps its own markup", () => {
        const service = new TurndownService({ safeLinks: true });

        service.keep(["p"]);
        expect(service.turndown(`<p><a href="https://example.com/a">ok</a> <a href="javascript:alert(1)">bad</a></p>`)).toBe(
            `<p><a href="https://example.com/a">ok</a> bad</p>`,
        );
    });

    it("a kept anchor with a safe href is written as HTML, as before", () => {
        const service = new TurndownService({ safeLinks: true });

        service.keep(["a"]);
        expect(service.turndown(`<a href="https://example.com/x">x</a>`)).toBe(`<a href="https://example.com/x">x</a>`);
    });

    it("without safeLinks, a kept unsafe anchor is written as HTML, unchanged", () => {
        const service = new TurndownService();

        service.keep(["a"]);
        expect(service.turndown(`<a href="javascript:alert(1)">x</a>`)).toBe(`<a href="javascript:alert(1)">x</a>`);
    });

    it("without safeLinks, a kept block with an unsafe anchor is written as HTML, unchanged", () => {
        const service = new TurndownService({ safeLinks: false });

        service.keep(["p"]);
        expect(service.turndown(`<p><a href="javascript:alert(1)">x</a></p>`)).toBe(`<p><a href="javascript:alert(1)">x</a></p>`);
    });
});
