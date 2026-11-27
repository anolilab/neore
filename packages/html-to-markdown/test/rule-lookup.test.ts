import { describe, expect, it } from "vitest";

import type { Rule } from "../src/index";
import TurndownService from "../src/index";

describe("the rule lookup", () => {
    // A filter written for elements reads an attribute. Asking about a text node must not hand it one.
    it("does not give a text node to a filter that expects an element", () => {
        const service = new TurndownService();

        service.addRule("element-only", {
            filter(node: Node) {
                return (node as Element).matches("span");
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

    it("gives the rule a node would get if a rule did not match it", () => {
        const service = new TurndownService();
        // Each passes its output on to the rule the node would get without it.
        const passOn = (filter: string, change: (content: string) => string): Rule => {
            const rule: Rule = {
                filter,
                replacement(content, node, options, lookup) {
                    const next = lookup.ruleAfter(rule, node);

                    return next.replacement.call(next, change(content), node, options, lookup);
                },
            };

            return rule;
        };

        service.addRule("lower", { filter: "p", replacement: (content: string) => `\n\n[lower ${content}]\n\n` });
        service.addRule(
            "upper",
            passOn("p", (content) => content.toUpperCase()),
        );
        service.addRule(
            "passes-to-built-in",
            passOn("em", (content) => `${content}!`),
        );
        service.addRule(
            "passes-to-default",
            passOn("kbd", (content) => `<${content}>`),
        );

        expect(service.turndown("<p>a <em>b</em> <kbd>c</kbd></p>")).toBe("[lower A _B!_ <C>]");
    });

    it("passes over a rule added twice, so the rule never gets itself back", () => {
        const service = new TurndownService();
        const rule: Rule = {
            filter: "em",
            replacement(content, node, options, lookup) {
                const next = lookup.ruleAfter(rule, node);

                return `[${next.replacement.call(next, content, node, options, lookup)}]`;
            },
        };

        service.addRule("first", rule);
        service.addRule("again", rule);

        expect(service.turndown("<p><em>a</em></p>")).toBe("[_a_]");
    });
});
