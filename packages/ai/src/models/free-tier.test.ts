import { describe, expect, it } from "vitest";

import { ANONYMOUS_FREE_MODEL, DEFAULT_CHAT_MODEL } from "../constants";
import { FREE_TIER_TEXT_MODELS, requiresPaidPlan } from "./free-tier";
import { MODEL_LOOKUP } from "./registry";

describe("free tier", () => {
    it("lists only enabled text models that exist", () => {
        for (const id of FREE_TIER_TEXT_MODELS) {
            const model = MODEL_LOOKUP.get(id);

            expect(model, id).toBeDefined();
            expect(model?.mode ?? "text", id).toBe("text");
            expect(model?.enabled, id).not.toBe(false);
        }
    });

    it("keeps the default and the guest model free, and gates the rest", () => {
        expect(requiresPaidPlan({ id: DEFAULT_CHAT_MODEL })).toBe(false);
        expect(requiresPaidPlan({ id: ANONYMOUS_FREE_MODEL })).toBe(false);
        expect(requiresPaidPlan({ id: "anthropic/claude-opus-4.6", mode: "text" })).toBe(true);
        expect(requiresPaidPlan({ id: "some-image-model", mode: "image" })).toBe(false);
        expect(requiresPaidPlan({ id: "pro-image-model", isPremium: true, mode: "image" })).toBe(true);
    });
});
