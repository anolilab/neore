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

    // A node already answered by an earlier rule keeps that answer when a newer rule is added in the same conversion.
    it("keeps the first answer for a node that a later rule would also match", () => {
        const service = new TurndownService();

        service.addRule("first", { filter: "span", replacement: () => "[1]" });
        service.addRule("ask-then-add", {
            filter(node: Node, _options, lookup) {
                if (node.nodeName !== "P") {
                    return false;
                }

                lookup.hasRuleFor(node.firstChild as Node);
                service.addRule("second", { filter: "span", replacement: () => "[2]" });

                return true;
            },
            replacement: (content: string) => content,
        });

        expect(service.turndown("<p><span>x</span></p>")).toBe("[1]");
    });

    // A filter that adds a rule matching a node while that node is being searched must not leave a stale no-match
    // answer behind: the later lookup has to see the new rule.
    it("finds a rule that a filter adds during the search for the same node", () => {
        const service = new TurndownService();
        let wasAdded = false;

        // The span's first search is the one that adds the rule for spans, so that search cannot see it.
        service.addRule("adds-matching-rule", {
            filter(node: Node) {
                if (!wasAdded && node.nodeName === "SPAN") {
                    wasAdded = true;
                    service.addRule("span", { filter: "span", replacement: () => "[S]" });
                }

                return false;
            },
            replacement: (content: string) => content,
        });

        // The div asks about its span twice: the first lookup adds the rule, so the second must find it.
        service.addRule("ask-twice", {
            filter(node: Node, _options, lookup) {
                if (node.nodeName !== "DIV") {
                    return false;
                }

                lookup.hasRuleFor(node.firstChild as Node);

                return lookup.hasRuleFor(node.firstChild as Node);
            },
            replacement: (content: string) => content,
        });

        expect(service.turndown("<div><span>x</span></div>")).toBe("[S]");
    });
});
