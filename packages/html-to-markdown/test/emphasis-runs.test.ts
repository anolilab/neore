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

    // An emphasis element whose only content is removed prints nothing, so it writes no delimiter and is no run member.
    it.each([
        ["after", "<em>a</em><em><span>b</span></em>", "_a_"],
        ["before", "<em><span>b</span></em><em>a</em>", "_a_"],
        ["after, with whitespace", "<strong>a</strong><b><span> b</span></b>", "**a**"],
    ])("closes the run when the emphasis %s it holds only a removed element", (_name, html, expected) => {
        const service = new TurndownService();

        service.remove("span");

        expect(service.turndown(html).trim()).toBe(expected);
    });

    // A caller's blankReplacement can print text for a blank element, so its output is not known from the DOM.
    it("splits the run at a blank element when a custom blankReplacement prints text", () => {
        const service = new TurndownService({ blankReplacement: () => "X" });

        expect(service.turndown("<em>a</em><span></span><em>b</em>")).toBe("*a*X*b*");
    });

    it("still splits the run at a custom rule that prints text", () => {
        const service = new TurndownService();

        service.addRule("span", { filter: "span", replacement: () => "x" });

        expect(service.turndown("<em>a</em><span>y</span><em>b</em>")).toBe("*a*x*b*");
    });
});

/*
 * Each member's walk decides on its own whether the next element joins the run. An element that would not be a run
 * member itself (here, one holding only an empty link) must not join from its side either, or one delimiter is left
 * without its partner.
 */

describe("emphasis beside an element holding only an empty link", () => {
    it.each([
        ["the empty link first", "<em><a href=/x></a></em><em>b</em>"],
        ["the empty link second", "<em>b</em><em><a href=/x></a></em>"],
    ])("pairs every delimiter with %s", (_name, html) => {
        const markdown = new TurndownService().turndown(html);

        expect(markdown.split("_").length % 2).toBe(1);
        expect(markdown).toContain("[](/x)");
    });
});

/*
 * A same-kind parent holding a block that a custom rule renders as nothing. The custom output is not known from the
 * DOM, so the parent does not share its delimiters; the inner element takes the asterisk. The result is emphasis
 * inside emphasis, as in the HTML, and never strong text.
 */

describe("nested emphasis beside a block that a custom rule renders as nothing", () => {
    it("writes emphasis inside emphasis, not strong text", () => {
        const service = new TurndownService();

        service.addRule("p", { filter: "p", replacement: () => "" });

        expect(service.turndown("<em><em>a</em><p>b</p></em>")).toBe("_*a*_");
    });
});

/*
 * Only a real break moves outside the delimiters. Inline text cannot carry a newline (whitespace collapses to a
 * space), so text that looks like the break marker never sits at an emphasis edge as a marker.
 */

describe("text that looks like the break marker inside emphasis", () => {
    it.each([
        ["at the start", "<em>X\nfoo</em>", "_X foo_"],
        ["at the end", "<em>fooX\n</em>", "_fooX_"],
    ])("stays inside the delimiters %s", (_name, html, expected) => {
        expect(new TurndownService({ br: "X" }).turndown(html)).toBe(expected);
    });

    it("moves a real break outside the delimiters", () => {
        expect(new TurndownService({ br: "X" }).turndown("<em><br>foo</em>")).toBe("X\n_foo_");
    });
});

/*
 * A removed element writes only its flanking whitespace. Both members' walks must reach the same answer about it,
 * so whitespace on either side of it ends the run for both, not only whitespace on the side a walk faces.
 */

describe("emphasis around a removed element with whitespace on one side", () => {
    it.each([
        ["leading whitespace", "<em>a</em><span> y</span><em>b</em>"],
        ["trailing whitespace", "<em>a</em><span>y </span><em>b</em>"],
    ])("pairs every delimiter with %s", (_name, html) => {
        const service = new TurndownService();

        service.remove("span");

        const markdown = service.turndown(html);

        expect(markdown.split("_").length % 2).toBe(1);
        expect(markdown).toBe("_a_ _b_");
    });
});

/*
 * An inline wrapper that prints its content as is (a span, an anchor with no link) is invisible to an emphasis run:
 * the walk climbs out of it at its edge and steps into it from outside, so emphasis inside a wrapper sees the same
 * neighbours as emphasis without one.
 */

describe("emphasis inside a wrapper that prints its content as is", () => {
    it.each([
        ["a span", "Bru<span><em>ss</em></span>el"],
        ["an anchor with no link", "Bru<a><em>ss</em></a>el"],
    ])("uses the intraword delimiter inside %s, as without the wrapper", (_name, html) => {
        expect(new TurndownService().turndown(html)).toBe("Bru*ss*el");
    });

    it.each([
        ["after the wrapper", "<em>a</em><span><em>b</em></span>"],
        ["before the wrapper", "<span><em>a</em></span><em>b</em>"],
    ])("joins adjacent emphasis %s into one run", (_name, html) => {
        expect(new TurndownService().turndown(html)).toBe("_ab_");
    });

    it("keeps the space at a wrapper's edge as a run boundary", () => {
        expect(new TurndownService().turndown("x<span> <em>a</em></span>")).toBe("x _a_");
    });
});

describe("emphasis beside a nested same-kind element that prints no delimiters", () => {
    it("reads the nested element's edge from its text", () => {
        expect(new TurndownService().turndown("<strong><em>a</em><strong>b</strong></strong>")).toBe("***a*b**");
    });
});

/*
 * The character beside emphasis is read as a whole code point, so a symbol or letter outside the Basic Multilingual
 * Plane (two UTF-16 units) is classed by what it is, not by one of its halves.
 */

describe("emphasis beside a character outside the Basic Multilingual Plane", () => {
    it.each([
        ["a symbol before", "\u{1F600}<em>a</em>", "\u{1F600}_a_"],
        ["a symbol after", "<em>a</em>\u{1F600}", "_a_\u{1F600}"],
        ["a letter before", "\u{1D400}<em>a</em>", "\u{1D400}*a*"],
        ["a letter after", "<em>a</em>\u{1D400}", "*a*\u{1D400}"],
    ])("classes %s by its code point", (_name, html, expected) => {
        expect(new TurndownService().turndown(html)).toBe(expected);
    });
});

/*
 * An empty delimiter option asks for no emphasis markup. A run beside a word character must keep it empty rather
 * than switch to the asterisk, which would add markup the caller turned off.
 */

describe("an empty emphasis or strong delimiter", () => {
    it.each([
        ["emphasis", { emDelimiter: "" }, "x<em>a</em>y"],
        ["strong text", { strongDelimiter: "" }, "x<strong>a</strong>y"],
    ])("writes no %s markup beside a word character", (_name, options, html) => {
        expect(new TurndownService(options).turndown(html)).toBe("xay");
    });
});
