import { describe, expect, it } from "vitest";

import { PROMPT_LINK_MAX_CHARS, readPromptLinkSearch } from "./prompt-link";

describe(readPromptLinkSearch, () => {
    it("takes hidden characters out and trims the prompt", () => {
        expect(readPromptLinkSearch({ model: " gpt ", prompt: "  Hi​ there\u{E0041}\n" })).toStrictEqual({ model: "gpt", prompt: "Hi there" });
    });

    it("cuts a long prompt at the cap without splitting an emoji", () => {
        const { prompt } = readPromptLinkSearch({ prompt: "😀".repeat(PROMPT_LINK_MAX_CHARS + 1) });

        expect([...(prompt ?? "")]).toHaveLength(PROMPT_LINK_MAX_CHARS);
        expect(prompt?.endsWith("😀")).toBe(true);
    });

    it("reads a value the router parsed as JSON back as its text", () => {
        expect(readPromptLinkSearch({ prompt: 42 })).toStrictEqual({ prompt: "42" });
    });

    it("carries nothing, not even the model, without a usable prompt", () => {
        expect(readPromptLinkSearch({ model: "gpt", prompt: " ​ " })).toStrictEqual({ prompt: "" });
        expect(readPromptLinkSearch({ model: "gpt", prompt: { a: 1 } })).toStrictEqual({ prompt: "" });
        expect(readPromptLinkSearch({ model: "gpt" })).toStrictEqual({});
    });
});
