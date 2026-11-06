import { describe, expect, it } from "vitest";

import { buildPromptLink, isPromptLinkTooLong, PROMPT_LINK_MAX_CHARS, PROMPT_LINK_MAX_QUERY_CHARS, promptFromLink, readPromptLinkSearch } from "./prompt-link";

const ORIGIN = "https://app.example.com";

/** The search a link carries, read back the way the route reads it. */
const searchOf = (link: string): Record<string, string> => Object.fromEntries(new URL(link).searchParams);

describe(buildPromptLink, () => {
    it("builds a new-chat link whose search reads back to the same prompt and model", () => {
        const link = buildPromptLink(ORIGIN, { model: "gpt-4o", prompt: "Summarise this\nin two lines" });

        expect(new URL(link).pathname).toBe("/chat");
        expect(readPromptLinkSearch(searchOf(link))).toEqual({ model: "gpt-4o", prompt: "Summarise this\nin two lines" });
    });

    it("leaves the model out when none is given", () => {
        expect(buildPromptLink(ORIGIN, { prompt: "hi" })).not.toContain("model=");
    });

    it("opens a long non-Latin prompt that the copy accepts, unchanged", () => {
        const prompt = "漢".repeat(800);
        const link = buildPromptLink(ORIGIN, { model: "gpt-4o", prompt });

        expect(link.length).toBeLessThanOrEqual(ORIGIN.length + "/chat?".length + PROMPT_LINK_MAX_QUERY_CHARS);
        expect(readPromptLinkSearch(searchOf(link))).toEqual({ model: "gpt-4o", prompt });
    });
});

describe(promptFromLink, () => {
    it("takes out hidden characters, so a link cannot smuggle instructions the composer would not show", () => {
        expect(promptFromLink("ok\u{E0041}\u{E0042} done\u{202E}")).toBe("ok done");
    });

    it("trims the text and cuts it at the cap, so a link cannot carry an unbounded draft", () => {
        expect(promptFromLink("  hello  ")).toBe("hello");
        expect(promptFromLink("a".repeat(PROMPT_LINK_MAX_CHARS + 50))).toHaveLength(PROMPT_LINK_MAX_CHARS);
    });

    it("keeps the whole text at the cap, even behind leading whitespace", () => {
        const body = "b".repeat(PROMPT_LINK_MAX_CHARS);

        expect(promptFromLink(`   ${body}`)).toBe(body);
    });

    it("cuts by code point, so an emoji at the cap is kept whole and never split in half", () => {
        const cut = promptFromLink(`${"a".repeat(PROMPT_LINK_MAX_CHARS - 1)}😀bc`);

        expect(cut).toBe(`${"a".repeat(PROMPT_LINK_MAX_CHARS - 1)}😀`);
        expect([...cut]).toHaveLength(PROMPT_LINK_MAX_CHARS);
    });

    it("drops an emoji that starts past the cap rather than keeping half of it", () => {
        const cut = promptFromLink(`${"a".repeat(PROMPT_LINK_MAX_CHARS)}😀`);

        expect(cut).toBe("a".repeat(PROMPT_LINK_MAX_CHARS));
    });
});

describe(isPromptLinkTooLong, () => {
    it("is true only when the cleaned text would not fit the link", () => {
        expect(isPromptLinkTooLong("a".repeat(PROMPT_LINK_MAX_CHARS))).toBe(false);
        expect(isPromptLinkTooLong(`  ${"a".repeat(PROMPT_LINK_MAX_CHARS)}  `)).toBe(false);
        expect(isPromptLinkTooLong("a".repeat(PROMPT_LINK_MAX_CHARS + 1))).toBe(true);
    });

    it("counts code points, so an emoji at the cap is not counted as two characters", () => {
        expect(isPromptLinkTooLong(`${"a".repeat(PROMPT_LINK_MAX_CHARS - 1)}😀`)).toBe(false);
        expect(isPromptLinkTooLong(`${"a".repeat(PROMPT_LINK_MAX_CHARS - 1)}😀b`)).toBe(true);
    });

    it("refuses a long non-Latin prompt under the character cap whose encoded link would be too long to open", () => {
        expect("漢".repeat(2000).length).toBeLessThan(PROMPT_LINK_MAX_CHARS);
        expect(isPromptLinkTooLong("漢".repeat(2000))).toBe(true);
        expect(isPromptLinkTooLong("漢".repeat(800))).toBe(false);
    });

    it("counts the model in the encoded link as well as the prompt", () => {
        expect(isPromptLinkTooLong("a".repeat(PROMPT_LINK_MAX_CHARS), "x".repeat(300))).toBe(true);
        expect(isPromptLinkTooLong("a".repeat(PROMPT_LINK_MAX_CHARS), "gpt-4o")).toBe(false);
    });
});

describe(readPromptLinkSearch, () => {
    it("drops blank and non-text values", () => {
        expect(readPromptLinkSearch({ model: "  ", prompt: " ".repeat(3) })).toEqual({});
        expect(readPromptLinkSearch({ model: 3, prompt: { text: "x" } })).toEqual({});
    });
});
