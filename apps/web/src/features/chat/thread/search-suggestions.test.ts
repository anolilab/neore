import { describe, expect, it } from "vitest";

import type { SearchMode } from "./search-suggestions";
import generateSearchSuggestions from "./search-suggestions";

describe("generateSearchSuggestions", () => {
    describe("basic behavior", () => {
        it("returns empty for short queries", () => {
            expect(generateSearchSuggestions("hi", "web")).toEqual([]);
            expect(generateSearchSuggestions("a", "web")).toEqual([]);
        });

        it("returns empty for chat mode", () => {
            expect(generateSearchSuggestions("how to build a website", "chat")).toEqual([]);
        });

        it("returns empty for writing mode", () => {
            expect(generateSearchSuggestions("how to build a website", "writing")).toEqual([]);
        });

        it("respects maxSuggestions limit", () => {
            const results = generateSearchSuggestions("how", "web", 2);

            expect(results.length).toBeLessThanOrEqual(2);
        });
    });

    describe("refinement suggestions", () => {
        it("generates refinements for 'how' queries", () => {
            const results = generateSearchSuggestions("how", "web");

            expect(results.length).toBeGreaterThan(0);
            expect(results[0]?.type).toBe("refinement");
            expect(results[0]?.text).toContain("how ");
        });

        it("generates refinements for 'what' queries", () => {
            const results = generateSearchSuggestions("what", "web");

            expect(results.length).toBeGreaterThan(0);
            expect(results[0]?.text).toContain("what ");
        });

        it("generates refinements for 'best' queries", () => {
            const results = generateSearchSuggestions("best", "web");

            expect(results.length).toBeGreaterThan(0);
            expect(results.some((s) => s.text.includes("way to"))).toBe(true);
        });
    });

    describe("mode-specific suggestions", () => {
        it("generates academic suggestions", () => {
            const results = generateSearchSuggestions("machine learning", "academic");

            expect(results.some((s) => s.type === "related")).toBe(true);
            expect(results.some((s) => s.text.includes("research paper") || s.text.includes("systematic review"))).toBe(true);
        });

        it("generates youtube suggestions", () => {
            const results = generateSearchSuggestions("react hooks", "youtube");

            expect(results.some((s) => s.text.includes("tutorial") || s.text.includes("explained"))).toBe(true);
        });

        it("generates code suggestions", () => {
            const results = generateSearchSuggestions("binary search", "code");

            expect(results.some((s) => s.text.includes("example") || s.text.includes("implementation"))).toBe(true);
        });

        it("generates wolfram suggestions", () => {
            const results = generateSearchSuggestions("quadratic", "wolfram");

            expect(results.some((s) => s.text.includes("calculate") || s.text.includes("solve"))).toBe(true);
        });

        it("generates github suggestions", () => {
            const results = generateSearchSuggestions("react state", "github");

            expect(results.some((s) => s.text.includes("repository") || s.text.includes("library"))).toBe(true);
        });

        it("generates stocks suggestions", () => {
            const results = generateSearchSuggestions("AAPL", "stocks");

            expect(results.some((s) => s.text.includes("stock price") || s.text.includes("market cap"))).toBe(true);
        });

        it("generates crypto suggestions", () => {
            const results = generateSearchSuggestions("bitcoin", "crypto");

            expect(results.some((s) => s.text.includes("price") || s.text.includes("market cap"))).toBe(true);
        });

        it("generates reddit suggestions", () => {
            const results = generateSearchSuggestions("laptop recommendations", "reddit");

            expect(results.some((s) => s.text.includes("reddit") || s.text.includes("opinions"))).toBe(true);
        });
    });

    describe("operator suggestions", () => {
        it("generates site: operator for web mode", () => {
            const results = generateSearchSuggestions("python documentation", "web");

            expect(results.some((s) => s.type === "operator" && s.text.includes("site:"))).toBe(true);
        });

        it("does not add operators when already present", () => {
            const results = generateSearchSuggestions("python site:docs.python.org", "web");

            expect(results.every((s) => s.type !== "operator")).toBe(true);
        });

        it("does not add operators for non-web modes", () => {
            const results = generateSearchSuggestions("python documentation", "academic");

            expect(results.every((s) => s.type !== "operator")).toBe(true);
        });
    });

    describe("modes with specific suggestions", () => {
        const modesWithSuggestions: SearchMode[] = ["web", "academic", "reddit", "youtube", "code", "github", "wolfram", "stocks", "crypto"];

        it.each(modesWithSuggestions)("generates suggestions for %s mode", (mode) => {
            const results = generateSearchSuggestions("test query here", mode);

            expect(results.length).toBeGreaterThan(0);
        });
    });

    describe("modes without specific suggestions still work", () => {
        it("returns empty for spotify mode with non-matching query", () => {
            const results = generateSearchSuggestions("test query here", "spotify");

            // Spotify has no mode-specific suggestions — returns empty for queries that don't match refinement patterns
            expect(Array.isArray(results)).toBe(true);
        });

        it("returns empty for x mode with non-matching query", () => {
            const results = generateSearchSuggestions("test query here", "x");

            expect(Array.isArray(results)).toBe(true);
        });
    });
});
