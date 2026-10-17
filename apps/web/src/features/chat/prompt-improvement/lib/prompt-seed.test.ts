import { describe, expect, it } from "vitest";

import { resolvePromptSeed } from "./prompt-seed";

describe("resolvePromptSeed", () => {
    it("does nothing while the saved prompt is the one the dialog was seeded from", () => {
        expect(resolvePromptSeed({ initialPrompt: "old", prompt: "edited", seed: "old" })).toBe("current");
    });

    it("reseeds from the newer saved prompt when the user has not edited", () => {
        expect(resolvePromptSeed({ initialPrompt: "new", prompt: "old", seed: "old" })).toBe("reseed");
    });

    it("keeps the user's edits and flags them when the saved prompt changed underneath", () => {
        expect(resolvePromptSeed({ initialPrompt: "new", prompt: "edited", seed: "old" })).toBe("stale-edits");
    });

    it("treats edits that already match the newer saved prompt as current", () => {
        expect(resolvePromptSeed({ initialPrompt: "new", prompt: "new", seed: "old" })).toBe("current");
    });
});
