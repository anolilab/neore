import { createDocument } from "@mixmark-io/domino";
import { describe, expect, it, vi } from "vitest";

import type { Rule } from "../src/index";
import TurndownService from "../src/index";

const NULL_INPUT_ERROR = /null is not a string/;
const UNDEFINED_INPUT_ERROR = /undefined is not a string/;
const INVALID_INPUT_MESSAGE = /is not a string, or an element\/document\/fragment node/;

const CDATA_SECTION_NODE = 4;

const BLANK_TEXT = /^\s*$/;

/**
 * Appends a CDATA section to an element. Domino has no CDATA node and never
 * yields one from HTML, so this text node is retyped to CDATA_SECTION_NODE, the
 * shape a browser DOM gives. Its clone keeps the type, since turndown clones
 * every DOM input before it converts it.
 */
function appendCdataSection(parent: Element, data: string): void {
    const htmlDocument = parent.ownerDocument as Document;

    const retype = (node: Text): void => {
        Object.defineProperties(node, {
            clone: {
                value: () => {
                    const copy = htmlDocument.createTextNode(data);

                    retype(copy);

                    return copy;
                },
            },
            nodeType: { value: CDATA_SECTION_NODE },
        });
    };

    const text = htmlDocument.createTextNode(data);

    // Domino has no ParentNode.append().
    // eslint-disable-next-line unicorn/prefer-dom-node-append
    parent.appendChild(text);
    retype(text);
}

const strikeRule: Rule = {
    filter: ["del", "s", "strike"],
    replacement(content) {
        return `~~${content}~~`;
    },
};

describe("turndown service API", () => {
    it("throws on null input", () => {
        expect(() => new TurndownService().turndown(null as unknown as string)).toThrow(NULL_INPUT_ERROR);
    });

    it("throws on undefined input", () => {
        expect(() => new TurndownService().turndown(undefined as unknown as string)).toThrow(UNDEFINED_INPUT_ERROR);
    });

    it("does not throw on malformed documents", () => {
        const service = new TurndownService();

        expect(() =>
            service.turndown(
                `<HTML><head></head><BODY><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "https://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><body onload=alert(document.cookie);></body></html>`,
            ),
        ).not.toThrow();
    });

    it("#addRule returns the instance", () => {
        const service = new TurndownService();

        expect(service.addRule("strikethrough", strikeRule)).toBe(service);
    });

    it("#addRule changes the Markdown output of matching elements", () => {
        const input = "<p><del>gone</del> kept</p>";

        expect(new TurndownService().turndown(input)).toBe("gone kept");
        expect(new TurndownService().addRule("strikethrough", strikeRule).turndown(input)).toBe("~~gone~~ kept");
    });

    it("#use returns the instance for chaining", () => {
        const service = new TurndownService();

        expect(service.use(() => {})).toBe(service);
    });

    it("#use with a single plugin calls the fn with instance", () => {
        const service = new TurndownService();
        const plugin = vi.fn();

        service.use(plugin);
        expect(plugin).toHaveBeenCalledWith(service);
    });

    it("#use with multiple plugins calls each fn with instance", () => {
        const service = new TurndownService();
        const plugin1 = vi.fn();
        const plugin2 = vi.fn();

        service.use([plugin1, plugin2]);
        expect(plugin1).toHaveBeenCalledWith(service);
        expect(plugin2).toHaveBeenCalledWith(service);
    });

    it("#keep keeps elements as HTML", () => {
        const service = new TurndownService();
        const input = "<p>Hello <del>world</del><ins>World</ins></p>";

        expect(service.turndown(input)).toBe("Hello worldWorld");

        service.keep(["del", "ins"]);
        expect(service.turndown(input)).toBe("Hello <del>world</del><ins>World</ins>");
    });

    it("#keep returns the TurndownService instance for chaining", () => {
        const service = new TurndownService();

        expect(service.keep(["del", "ins"])).toBe(service);
    });

    it("keep rules are overridden by the standard rules", () => {
        const service = new TurndownService();

        service.keep("p");
        expect(service.turndown("<p>Hello world</p>")).toBe("Hello world");
    });

    it("keeping elements that have a blank textContent but contain significant elements", () => {
        const service = new TurndownService();

        service.keep("figure");
        expect(service.turndown(`<figure><iframe src="https://example.com"></iframe></figure>`)).toBe(
            `<figure><iframe src="https://example.com"></iframe></figure>`,
        );
    });

    it("keepReplacement can be customised", () => {
        const service = new TurndownService({
            keepReplacement(_content, node) {
                return `\n\n${node.outerHTML}\n\n`;
            },
        });

        service.keep(["del", "ins"]);
        expect(service.turndown("<p>Hello <del>world</del><ins>World</ins></p>")).toBe("Hello \n\n<del>world</del>\n\n<ins>World</ins>");
    });

    it("#remove removes elements", () => {
        const service = new TurndownService();
        const input = "<del>Please redact me</del>";

        expect(service.turndown(input)).toBe("Please redact me");

        service.remove("del");
        expect(service.turndown(input)).toBe("");
    });

    it("#remove returns the TurndownService instance for chaining", () => {
        const service = new TurndownService();

        expect(service.remove(["del", "ins"])).toBe(service);
    });

    it("remove elements are overridden by rules", () => {
        const service = new TurndownService();

        service.remove("p");
        expect(service.turndown("<p>Hello world</p>")).toBe("Hello world");
    });

    it("remove elements are overridden by keep", () => {
        const service = new TurndownService();

        service.keep(["del", "ins"]);
        service.remove(["del", "ins"]);
        expect(service.turndown("<p>Hello <del>world</del><ins>World</ins></p>")).toBe("Hello <del>world</del><ins>World</ins>");
    });
});

describe("invalid input", () => {
    it("rejects an object that only imitates an element", () => {
        expect(() => new TurndownService().turndown({ nodeType: 1 } as unknown as string)).toThrow(INVALID_INPUT_MESSAGE);
    });

    it("rejects an object with a nodeType and no cloneNode", () => {
        expect(() => new TurndownService().turndown({ nodeType: 9 } as unknown as string)).toThrow(INVALID_INPUT_MESSAGE);
    });

    it("rejects an object without a prototype with the package error", () => {
        expect(() => new TurndownService().turndown(Object.create(null) as string)).toThrow(INVALID_INPUT_MESSAGE);
    });
});

describe("input that contains the wrapper's closing tag", () => {
    it("does not end the conversion early at a literal </x-turndown>", () => {
        expect(new TurndownService().turndown("a</x-turndown>b")).toBe("ab");
    });

    it("still converts markup after the wrapper's name", () => {
        expect(new TurndownService().turndown("<p>x</p>")).toBe("x");
    });
});

describe("unclosed raw-text elements in string input", () => {
    it("does not write the wrapper's closing tag into an unclosed textarea", () => {
        expect(new TurndownService().turndown("<textarea>hello")).toBe("hello");
    });

    it("does not write the wrapper's closing tag into an unclosed plaintext element", () => {
        expect(new TurndownService().turndown("<plaintext>hello")).toBe("hello");
    });
});

describe("CDATA sections in DOM input", () => {
    // A CDATA section prints its text, so an emphasis run must not join across it as if it printed nothing.
    it("keeps a CDATA section between emphasis outside the emphasis", () => {
        const htmlDocument = createDocument("<p><em>a</em></p>");
        const paragraph = htmlDocument.querySelector("p") as Element;
        const second = htmlDocument.createElement("em");

        second.textContent = "b";
        appendCdataSection(paragraph, "x");
        // Domino has no ParentNode.append().
        // eslint-disable-next-line unicorn/prefer-dom-node-append
        paragraph.appendChild(second);

        expect(new TurndownService().turndown(paragraph)).toBe("*a*x*b*");
    });

    it("converts the text of a CDATA section in a paragraph", () => {
        const htmlDocument = createDocument("<p>before </p>");
        const paragraph = htmlDocument.querySelector("p") as Element;

        appendCdataSection(paragraph, "a *b* & c");
        expect(new TurndownService().turndown(paragraph)).toBe(String.raw`before a \*b\* & c`);
    });

    it("keeps the text of a CDATA section in code unescaped, as for text nodes", () => {
        // Domino's textContent skips CDATA, so a code element holding only a CDATA
        // section reads as blank. The leading text node keeps it non-blank here.
        const withText = createDocument("<p><code>a </code></p>").querySelector("p") as Element;
        const withCdata = createDocument("<p><code>a </code></p>").querySelector("p") as Element;

        const textCode = withText.querySelector("code") as Element;

        // eslint-disable-next-line unicorn/prefer-dom-node-append -- domino has no ParentNode.append()
        textCode.appendChild(textCode.ownerDocument.createTextNode("*b* & c"));
        appendCdataSection(withCdata.querySelector("code") as Element, "*b* & c");

        const service = new TurndownService();

        expect(service.turndown(withCdata)).toBe(service.turndown(withText));
        expect(service.turndown(withCdata)).toBe("`a *b* & c`");
    });

    it("blanks a code element holding only a CDATA section exactly when its textContent is blank", () => {
        const code = createDocument("<p><code></code></p>").querySelector("code") as Element;

        appendCdataSection(code, "*b* & c");

        // Domino's textContent skips CDATA, so this reads blank there; a browser's does not.
        const expected = BLANK_TEXT.test(code.textContent ?? "") ? "" : "`*b* & c`";

        expect(new TurndownService().turndown(code.parentElement as Element)).toBe(expected);
    });

    it("blanks a paragraph holding only a CDATA section exactly when its textContent is blank", () => {
        // The paragraph is a child, so its blankness decides the rule it takes.
        const container = createDocument("<div><p></p></div>").querySelector("div") as Element;
        const paragraph = container.querySelector("p") as Element;

        appendCdataSection(paragraph, "text");

        const expected = BLANK_TEXT.test(paragraph.textContent ?? "") ? "" : "text";

        expect(new TurndownService().turndown(container)).toBe(expected);
    });
});
