import { describe, expect, it } from "vitest";

import { buildPromptLink, PROMPT_LINK_MAX_CHARS, promptFromLink, readPromptLinkSearch } from "./prompt-link";

describe(buildPromptLink, () => {
    it("builds a new-chat link whose search reads back to the same prompt and model", () => {
        const link = buildPromptLink("https://app.example.com", { model: "gpt-4o", prompt: "Summarise this\nin two lines" });
        const search = Object.fromEntries(new URL(link).searchParams);

        expect(new URL(link).pathname).toBe("/chat");
        expect(readPromptLinkSearch(search)).toEqual({ model: "gpt-4o", prompt: "Summarise this\nin two lines" });
    });

    it("leaves the model out when none is given", () => {
        expect(buildPromptLink("https://app.example.com", { prompt: "hi" })).not.toContain("model=");
    });
});

describe(promptFromLink, () => {
    it("trims the text and cuts it at the cap, so a link cannot carry an unbounded draft", () => {
        expect(promptFromLink("  hello  ")).toBe("hello");
        expect(promptFromLink("a".repeat(PROMPT_LINK_MAX_CHARS + 50))).toHaveLength(PROMPT_LINK_MAX_CHARS);
    });
});

describe(readPromptLinkSearch, () => {
    it("drops blank and non-text values", () => {
        expect(readPromptLinkSearch({ model: "  ", prompt: " ".repeat(3) })).toEqual({});
        expect(readPromptLinkSearch({ model: 3, prompt: { text: "x" } })).toEqual({});
    });
});
