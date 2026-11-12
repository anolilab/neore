import { describe, expect, it, vi } from "vitest";

import type { Rule } from "../src/index";
import TurndownService from "../src/index";

const NULL_INPUT_ERROR = /null is not a string/;
const UNDEFINED_INPUT_ERROR = /undefined is not a string/;

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

    it("#addRule adds the rule", () => {
        const service = new TurndownService();
        const add = vi.fn();

        service.rules.add = add;
        service.addRule("strikethrough", strikeRule);
        expect(add).toHaveBeenCalledWith("strikethrough", strikeRule);
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
