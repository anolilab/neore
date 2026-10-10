import { describe, expect, it } from "vitest";

import { applyRoutingProfile, classifyTier, QueryTier, TIER_MODEL_POOLS } from "./tiers.js";

describe("applyRoutingProfile", () => {
    it("defers to the scored tier under `auto`", () => {
        for (const tier of Object.values(QueryTier)) {
            expect(applyRoutingProfile(tier, "auto")).toBe(tier);
        }
    });

    it("pins the tier for every non-auto profile, whatever the score said", () => {
        expect(applyRoutingProfile(QueryTier.Reasoning, "eco")).toBe(QueryTier.Simple);
        expect(applyRoutingProfile(QueryTier.Reasoning, "free")).toBe(QueryTier.Simple);
        expect(applyRoutingProfile(QueryTier.Reasoning, "fast")).toBe(QueryTier.Simple);
        expect(applyRoutingProfile(QueryTier.Simple, "premium")).toBe(QueryTier.Complex);
        expect(applyRoutingProfile(QueryTier.Simple, "reasoning")).toBe(QueryTier.Reasoning);
    });

    it("only ever returns a tier that has a model pool", () => {
        for (const profile of ["auto", "eco", "fast", "free", "premium", "reasoning"] as const) {
            const tier = applyRoutingProfile(QueryTier.Standard, profile);

            expect(TIER_MODEL_POOLS[tier]?.length).toBeGreaterThan(0);
        }
    });

    it("classifyTier covers the whole 0..1 range", () => {
        expect(classifyTier(0)).toBe(QueryTier.Simple);
        expect(classifyTier(0.4)).toBe(QueryTier.Standard);
        expect(classifyTier(0.7)).toBe(QueryTier.Complex);
        expect(classifyTier(1)).toBe(QueryTier.Reasoning);
    });
});
