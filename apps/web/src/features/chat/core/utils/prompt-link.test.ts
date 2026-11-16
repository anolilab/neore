import { describe, expect, it } from "vitest";

import { buildPromptLink, isPromptLinkTooLong, PROMPT_LINK_MAX_CHARS, promptFromLink, readPromptLinkSearch } from "./prompt-link";

describe(readPromptLinkSearch, () => {
    it("takes hidden characters out and trims the prompt", () => {
        expect(readPromptLinkSearch({ model: " gpt ", prompt: "  Hi​ there\u{E0041}\n" })).toStrictEqual({ model: "gpt", prompt: "Hi there" });
    });

    it("cuts a long prompt at the cap without splitting an emoji", () => {
        const { prompt } = readPromptLinkSearch({ prompt: "😀".repeat(PROMPT_LINK_MAX_CHARS + 1) });

        expect([...(prompt ?? "")]).toHaveLength(PROMPT_LINK_MAX_CHARS);
        expect(prompt?.endsWith("😀")).toBe(true);
    });

    it("keeps a prompt that looks like JSON as it was written", () => {
        expect(readPromptLinkSearch({ prompt: "1.50" })).toStrictEqual({ prompt: "1.50" });
        expect(readPromptLinkSearch({ prompt: '{"task":"summarise"}' })).toStrictEqual({ prompt: '{"task":"summarise"}' });
    });

    it("carries nothing, not even the model, without a usable prompt", () => {
        expect(readPromptLinkSearch({ model: "gpt", prompt: " ​ " })).toStrictEqual({ prompt: "" });
        expect(readPromptLinkSearch({ model: "gpt" })).toStrictEqual({});
    });
});

describe(buildPromptLink, () => {
    it("copies text cut inside an emoji pair, with the replacement character for the lone half", () => {
        const link = new URL(buildPromptLink("https://app.test", { prompt: "cut \u{D83D} here" }));

        expect(readPromptLinkSearch({ prompt: link.searchParams.get("prompt") ?? undefined }).prompt).toBe("cut \u{FFFD} here");
    });

    /** What the chat page reads from a copied link: the raw query, as `routes/(chat)/chat/index.tsx` does. */
    const readBack = (link: string) => {
        const url = new URL(link);

        return {
            origin: url.origin,
            ...readPromptLinkSearch({ model: url.searchParams.get("model") ?? undefined, prompt: url.searchParams.get("prompt") ?? undefined }),
        };
    };

    it.each(["a+b = c", "100% sure", "1.50", "naïve 😀 日本語 & more=yes#top"])("reads %s back as the same prompt and model", (prompt) => {
        expect(readBack(buildPromptLink("https://app.example", { model: "openai/gpt-5", prompt }))).toStrictEqual({
            model: "openai/gpt-5",
            origin: "https://app.example",
            prompt,
        });
    });

    it("carries a prompt over the cap as the open would cut it, and the copy refuses it", () => {
        const prompt = "x".repeat(PROMPT_LINK_MAX_CHARS + 1);

        expect(readBack(buildPromptLink("https://app.example", { prompt })).prompt).toBe(promptFromLink(prompt));
        expect(isPromptLinkTooLong(prompt)).toBe(true);
        expect(isPromptLinkTooLong("x".repeat(PROMPT_LINK_MAX_CHARS))).toBe(false);
    });

    it("refuses a prompt under the cap whose encoded address would be too long to open", () => {
        expect(isPromptLinkTooLong("日".repeat(PROMPT_LINK_MAX_CHARS))).toBe(true);
    });
});
