import { MODEL_REGISTRY } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { buildPromptLink, carriableLinkModel, isPromptLinkTooLong, PROMPT_LINK_MAX_CHARS, promptFromLink, readPromptLinkSearch } from "./prompt-link";

describe(carriableLinkModel, () => {
    it("names an enabled text model the composer picks", () => {
        const textModel = MODEL_REGISTRY.find((model) => (model.mode ?? "text") === "text" && model.enabled !== false && model.provider !== "external");

        expect(textModel).toBeDefined();
        expect(carriableLinkModel(textModel?.id)?.id).toBe(textModel?.id);
    });

    it("names no model for a custom endpoint, an image model, an external model, an unknown id or nothing", () => {
        const imageModel = MODEL_REGISTRY.find((model) => model.mode === "image" && model.enabled !== false);

        expect(imageModel).toBeDefined();
        expect(carriableLinkModel("custom:ollama/llama3.1:8b")).toBeUndefined();
        expect(carriableLinkModel(imageModel?.id)).toBeUndefined();
        expect(carriableLinkModel("ext/mimo-v2-flash")).toBeUndefined();
        expect(carriableLinkModel("not-a-real-model")).toBeUndefined();
        expect(carriableLinkModel(undefined)).toBeUndefined();
    });
});

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
});

describe(isPromptLinkTooLong, () => {
    it("is true only when the cleaned text would not fit the link", () => {
        expect(isPromptLinkTooLong("a".repeat(PROMPT_LINK_MAX_CHARS))).toBe(false);
        expect(isPromptLinkTooLong(`  ${"a".repeat(PROMPT_LINK_MAX_CHARS)}  `)).toBe(false);
        expect(isPromptLinkTooLong("a".repeat(PROMPT_LINK_MAX_CHARS + 1))).toBe(true);
    });
});

describe(readPromptLinkSearch, () => {
    it("drops blank and non-text values", () => {
        expect(readPromptLinkSearch({ model: "  ", prompt: " ".repeat(3) })).toEqual({});
        expect(readPromptLinkSearch({ model: 3, prompt: { text: "x" } })).toEqual({});
    });
});
