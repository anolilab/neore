import { createDocument } from "@mixmark-io/domino";
import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

describe("keep and remove on built-in tags (upstream #455)", () => {
    it("keep renders a built-in tag as HTML", () => {
        const service = new TurndownService();

        service.keep(["b"]);
        expect(service.turndown("<p>a <b>bold</b></p>")).toBe("a <b>bold</b>");
    });

    it("keep renders nested built-in tags as HTML", () => {
        const service = new TurndownService();

        service.keep(["b", "i"]);
        expect(service.turndown("<b>Hello <i>World</i></b>")).toBe("<b>Hello <i>World</i></b>");
    });

    it("remove drops a built-in tag and its content", () => {
        const service = new TurndownService();

        service.remove(["i"]);
        expect(service.turndown("<p>a <i>it</i></p>")).toBe("a");
    });

    it("remove drops the nested content of a built-in tag", () => {
        const service = new TurndownService();

        service.remove(["b"]);
        expect(service.turndown("<p>a<b>Hello <i>World</i></b>c</p>")).toBe("ac");
    });

    it("a tag in both lists is kept, because keep is checked before remove", () => {
        const service = new TurndownService();

        service.keep(["b"]);
        service.remove(["b"]);
        expect(service.turndown("<p>a <b>bold</b></p>")).toBe("a <b>bold</b>");
    });

    it("a rule added with addRule still wins over keep", () => {
        const service = new TurndownService();

        service.addRule("bracket", { filter: "b", replacement: (content) => `[${content}]` });
        service.keep(["b"]);
        expect(service.turndown("<p>a <b>bold</b></p>")).toBe("a [bold]");
    });

    it("a rule added with addRule still wins over remove", () => {
        const service = new TurndownService();

        service.addRule("bracket", { filter: "b", replacement: (content) => `[${content}]` });
        service.remove(["b"]);
        expect(service.turndown("<p>a <b>bold</b></p>")).toBe("a [bold]");
    });

    it("blank elements are left to the blank rule", () => {
        const service = new TurndownService();

        service.keep(["b"]);
        expect(service.turndown("<p>a<b></b>c</p>")).toBe("ac");
    });

    it("the blank rule comes before keep, so a blank kept tag gives nothing", () => {
        const service = new TurndownService();

        service.keep(["p"]);
        expect(service.turndown("<p></p>a")).toBe("a");
    });

    it("the blank rule comes before addRule, so a blank element is not passed to the added rule", () => {
        const service = new TurndownService();

        service.addRule("bracket", { filter: "p", replacement: (content) => `[${content}]` });
        expect(service.turndown("<p></p>a")).toBe("a");
    });

    it("remove does not convert the removed content, so its link definitions are not emitted", () => {
        const service = new TurndownService({ linkStyle: "referenced" });

        service.remove(["div"]);
        expect(service.turndown(`<div><a href="x">l</a></div><p>after</p>`)).toBe("after");
    });

    it("a custom keepReplacement on a built-in tag receives the converted children", () => {
        const service = new TurndownService({ keepReplacement: (content) => `{${content}}` });

        service.keep(["b"]);
        expect(service.turndown("<p>a <b><i>x</i></b></p>")).toBe("a {_x_}");
    });

    it("a kept tag inside a removed one is dropped with it", () => {
        const service = new TurndownService();

        service.keep(["b"]);
        service.remove(["div"]);
        expect(service.turndown("<div><b>x</b></div>y")).toBe("y");
    });

    it("remove drops a referenced link nested in another link, unlike upstream, which leaks its definitions", () => {
        const service = new TurndownService({ linkStyle: "referenced" });

        service.remove(["div"]);
        expect(service.turndown(`<a href="y">m<div><a href="x">n</a></div></a>`)).toBe("[m][1]\n\n[1]: y");
    });

    it("the default keepReplacement skips the children, so a referenced link inside leaves no orphan definition", () => {
        const service = new TurndownService({ linkStyle: "referenced" });

        service.keep(["p"]);
        expect(service.turndown(`<p><a href="x">l</a></p>`)).toBe(`<p><a href="x">l</a></p>`);
    });

    it("a custom keepReplacement still converts the children, so a referenced link keeps its definition", () => {
        const service = new TurndownService({ keepReplacement: (content) => `{${content}}`, linkStyle: "referenced" });

        service.keep(["span"]);
        expect(service.turndown(`<span><a href="x">l</a></span>`)).toBe("{[l][1]}\n\n[1]: x");
    });

    it("a custom keepReplacement that ignores content still converts the children, so the link keeps its definition", () => {
        const service = new TurndownService({
            keepReplacement: (_content, node) => node.outerHTML,
            linkStyle: "referenced",
        });

        service.keep(["span"]);
        expect(service.turndown(`<span><a href="x">l</a></span>`)).toBe(`<span><a href="x">l</a></span>\n\n[1]: x`);
    });
});

describe("behaviour that already holds (regression tests, no code change)", () => {
    it("a form input named parentNode does not break a string input (upstream #508)", () => {
        expect(new TurndownService().turndown(`<form><input name="parentNode"></form>text`)).toBe("text");
        expect(new TurndownService().turndown("<form><input id=parentNode></form>text")).toBe("text");
    });

    it("a form input named parentNode does not break a Node input (upstream #508)", () => {
        const document = createDocument(`<form><input name="parentNode"></form>text`);

        expect(new TurndownService().turndown(document)).toBe("text");
    });

    it("a # at the start of a span is escaped, not read as a heading (upstream #470)", () => {
        expect(new TurndownService().turndown(`<span class="comment"># here is a comment</span>.`)).toBe(String.raw`\# here is a comment.`);
    });

    it("inline code in a heading keeps its backticks (upstream #507)", () => {
        expect(new TurndownService().turndown("<h4><code>x</code> y</h4>")).toBe("#### `x` y");
    });
});
