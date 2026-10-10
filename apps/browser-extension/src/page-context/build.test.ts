import { describe, expect, it } from "vitest";

import {
    buildPageContext,
    estimateTokens,
    normalizeText,
    PAGE_CONTEXT_BUDGET,
    PageContextError,
    sanitizePageUrl,
    truncateToBudget,
    TRUNCATION_MARKER,
} from "./build";
import { isCapturableUrl } from "./capture";

describe("normalizeText", () => {
    it("collapses spaces and blank lines and normalises line endings", () => {
        expect(normalizeText("  a \t b\r\n\r\n\r\n\r\nc  \n  d  ")).toBe("a b\n\nc\nd");
    });

    it("strips whitespace around every newline of a blank-line run", () => {
        expect(normalizeText("a \t\n \t\n  b")).toBe("a\n\nb");
        expect(normalizeText("a \r\n\t\r\n \n\n  b")).toBe("a\n\nb");
    });
});

describe("truncateToBudget", () => {
    it("leaves text within budget alone", () => {
        expect(truncateToBudget("short", 100)).toEqual({ text: "short", truncated: false });
    });

    it("never exceeds the budget, marker included", () => {
        const input = "word ".repeat(10_000);

        for (const budget of [50, 500, 5000]) {
            const { text, truncated } = truncateToBudget(input, budget);

            expect(truncated).toBe(true);
            expect(text.length).toBeLessThanOrEqual(budget);
            expect(text.endsWith(TRUNCATION_MARKER)).toBe(true);
        }
    });

    it("prefers a paragraph break near the end of the window", () => {
        const input = `${"a".repeat(900)}\n\n${"b".repeat(900)}`;
        const { text } = truncateToBudget(input, 1000);

        expect(text).toBe(`${"a".repeat(900)}${TRUNCATION_MARKER}`);
    });

    it("falls back to a sentence end, then a word boundary", () => {
        const sentences = `${"x".repeat(850)}. ${"y".repeat(200)}`;

        expect(truncateToBudget(sentences, 1000).text).toBe(`${"x".repeat(850)}.${TRUNCATION_MARKER}`);

        const words = `${"z".repeat(900)} ${"w".repeat(200)}`;

        expect(truncateToBudget(words, 1000).text).toBe(`${"z".repeat(900)}${TRUNCATION_MARKER}`);
    });

    it("cuts mid-word rather than discard most of the budget for an early break", () => {
        const input = `intro\n\n${"q".repeat(5000)}`;
        const { text } = truncateToBudget(input, 1000);

        expect(text).toHaveLength(1000);
    });
});

describe("sanitizePageUrl", () => {
    it("keeps ordinary http(s) URLs but drops credentials and fragments", () => {
        expect(sanitizePageUrl("https://user:pass@example.com/a?b=1#section")).toBe("https://example.com/a?b=1");
        // eslint-disable-next-line unicorn/prefer-https -- plain http is the case under test
        expect(sanitizePageUrl("http://example.com/")).toBe("http://example.com/");
    });

    it("rejects every other scheme", () => {
        for (const url of [
            "chrome://settings",
            "chrome-extension://abc/page.html",
            "file:///etc/passwd",
            // eslint-disable-next-line no-script-url -- a `javascript:` URL is test data here: it must be rejected
            "javascript:alert(1)",
            "data:text/html,hi",
            "about:blank",
            "nonsense",
        ]) {
            expect(sanitizePageUrl(url)).toBeUndefined();
        }
    });
});

describe("isCapturableUrl", () => {
    it("allows ordinary web pages only", () => {
        expect(isCapturableUrl("https://example.com/article")).toBe(true);
        expect(isCapturableUrl("http://localhost:3000/")).toBe(true);
    });

    it("refuses browser, extension, local and store pages", () => {
        for (const url of [
            undefined,
            "",
            "chrome://newtab",
            "edge://settings",
            "about:blank",
            "file:///home/me/notes.txt",
            "view-source:https://example.com",
            "chrome-extension://abcdef/popup.html",
            "moz-extension://abc/page.html",
            "https://chromewebstore.google.com/detail/x",
            "https://chrome.google.com/webstore/detail/x",
        ]) {
            expect(isCapturableUrl(url)).toBe(false);
        }
    });
});

describe("buildPageContext", () => {
    it("builds the start-payload field from extractor output", () => {
        const context = buildPageContext({ selection: "", text: "Body\n\n\n\ntext", title: "  A   title ", url: "https://example.com/post#top" });

        expect(context).toEqual({ text: "Body\n\ntext", title: "A title", url: "https://example.com/post" });
    });

    it("applies the text and selection budgets", () => {
        const context = buildPageContext({
            selection: "s ".repeat(10_000),
            text: "t ".repeat(100_000),
            title: "x".repeat(1000),
            url: "https://example.com",
        });

        expect(context.text!.length).toBeLessThanOrEqual(PAGE_CONTEXT_BUDGET.text);
        expect(context.selection!.length).toBeLessThanOrEqual(PAGE_CONTEXT_BUDGET.selection);
        expect(context.title.length).toBeLessThanOrEqual(PAGE_CONTEXT_BUDGET.title);
        expect(estimateTokens(context)).toBeLessThanOrEqual((PAGE_CONTEXT_BUDGET.text + PAGE_CONTEXT_BUDGET.selection) / 4);
    });

    it("omits the page text for a selection-only context", () => {
        const context = buildPageContext({ selection: "chosen", text: "ignored", title: "T", url: "https://example.com" }, { includeText: false });

        expect(context).toEqual({ selection: "chosen", title: "T", url: "https://example.com/" });
    });

    it("falls back to the host name for an untitled page", () => {
        expect(buildPageContext({ text: "body", title: "", url: "https://docs.example.com/x" }).title).toBe("docs.example.com");
    });

    it("refuses unsupported URLs and empty pages", () => {
        expect(() => buildPageContext({ text: "body", title: "t", url: "chrome://settings" })).toThrow(PageContextError);
        expect(() => buildPageContext({ selection: "  ", text: "\n\n", title: "t", url: "https://example.com" })).toThrow(PageContextError);
    });
});
