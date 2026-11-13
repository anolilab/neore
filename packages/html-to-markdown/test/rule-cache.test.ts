import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

describe("the rule lookup cache", () => {
    // A filter asks about a span before the rule for spans is added. The negative answer must not survive the
    // addRule, or the span is rendered with the default replacement instead of the new rule.
    it("applies a rule added after a negative lookup for the same node", () => {
        const service = new TurndownService();

        service.addRule("registers-late", {
            filter(node: Node, _options, lookup) {
                if (node.nodeName !== "DIV") {
                    return false;
                }

                if (!lookup.hasRuleFor(node.firstChild as Node)) {
                    service.addRule("span-rule", { filter: "span", replacement: () => "[S]" });
                }

                return true;
            },
            replacement: (content: string) => content,
        });

        expect(service.turndown("<div><span>x</span></div>")).toBe("[S]");
    });
});
