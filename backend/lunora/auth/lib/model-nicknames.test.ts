import { describe, expect, it } from "vitest";

import { normalizeModelNicknames } from "./model-nicknames";

describe("normalizeModelNicknames", () => {
    it("trims and collapses whitespace, newlines included", () => {
        expect(normalizeModelNicknames({ "openai/gpt-5": "  my \n\t fast   model " })).toEqual({ "openai/gpt-5": "my fast model" });
    });

    it("drops blank nicknames, which is how a client clears one", () => {
        expect(normalizeModelNicknames({ "a/b": " ".repeat(3), "c/d": "keep" })).toEqual({ "c/d": "keep" });
    });

    it("drops entries without a model id", () => {
        expect(normalizeModelNicknames({ "  ": "orphan" })).toEqual({});
    });

    it("stores a padded model id under its trimmed key", () => {
        expect(normalizeModelNicknames({ " openai/model ": "Fast" })).toEqual({ "openai/model": "Fast" });
    });

    it("keeps the later entry when two ids collide after trimming", () => {
        expect(normalizeModelNicknames({ "a/b": "First", " a/b ": "Second" })).toEqual({ "a/b": "Second" });
    });

    it("leaves a clean map as it was", () => {
        const clean = { "a/b": "One", "c/d": "Two" };

        expect(normalizeModelNicknames(clean)).toEqual(clean);
    });
});
