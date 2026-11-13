import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

describe("the rule lookup", () => {
    // A filter written for elements reads an attribute. Asking about a text node must not hand it one.
    it("does not give a text node to a filter that expects an element", () => {
        const service = new TurndownService();

        service.addRule("element-only", {
            filter(node: Node) {
                return (node as Element).hasAttribute("data-x");
            },
            replacement: (content: string) => content,
        });

        service.addRule("asks-about-text", {
            filter(node: Node, _options, lookup) {
                if (node.nodeName !== "SPAN") {
                    return false;
                }

                return lookup.hasRuleFor(node.firstChild as Node);
            },
            replacement: (content: string) => `[${content}]`,
        });

        expect(service.turndown("<span>x</span>")).toBe("x");
    });
});
