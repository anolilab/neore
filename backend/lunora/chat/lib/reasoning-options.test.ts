import { describe, expect, it } from "vitest";

import { buildReasoningProviderOptions, toReasoningLevel } from "./reasoning-options";

describe("toReasoningLevel", () => {
    it("collapses the slider's five stops onto three levels", () => {
        expect(toReasoningLevel(0)).toBe("low");
        expect(toReasoningLevel(25)).toBe("low");
        expect(toReasoningLevel(50)).toBe("medium");
        expect(toReasoningLevel(75)).toBe("high");
        expect(toReasoningLevel(100)).toBe("high");
    });
});

describe("buildReasoningProviderOptions", () => {
    it("keys the bag by provider name, which is what the gateway filter indexes", () => {
        const options = buildReasoningProviderOptions(100, "openai", true);

        // The regression this guards: a FLAT `{ reasoningEffort }` made
        // `filterProviderOptions` return undefined and the option vanished.
        expect(options).toEqual({ openai: { reasoningEffort: "high" } });
        expect(options?.["openai"]).toBeDefined();
    });

    it("uses each provider's own allowlisted key", () => {
        expect(buildReasoningProviderOptions(50, "openrouter", true)).toEqual({ openrouter: { reasoning: { effort: "medium" } } });
        expect(buildReasoningProviderOptions(0, "openai", true)).toEqual({ openai: { reasoningEffort: "low" } });
    });

    it('resolves the midpoint upward for xAI, which rejects "medium"', () => {
        expect(buildReasoningProviderOptions(50, "xai", true)).toEqual({ xai: { reasoningEffort: "high" } });
        expect(buildReasoningProviderOptions(0, "xai", true)).toEqual({ xai: { reasoningEffort: "low" } });
    });

    it("sends nothing for providers with no effort control rather than risk a 400", () => {
        expect(buildReasoningProviderOptions(100, "anthropic", true)).toBeUndefined();
        expect(buildReasoningProviderOptions(100, "google", true)).toBeUndefined();
        expect(buildReasoningProviderOptions(100, "", true)).toBeUndefined();
    });

    it("sends nothing when unset or unsupported", () => {
        expect(buildReasoningProviderOptions(undefined, "openai", true)).toBeUndefined();
        expect(buildReasoningProviderOptions(100, "openai", false)).toBeUndefined();
    });
});
