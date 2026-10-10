import { describe, expect, it } from "vitest";

import { VerdictCache } from "../routing/cache.js";
import { detectTierOverride } from "../routing/override.js";
import { decideTier, POLICY_THRESHOLDS } from "../routing/policy.js";
import type { ModelCandidate } from "../routing/selector.js";
import { computeStaticTierPools } from "../routing/tier-assignment.js";
import { isTierAllowedFor, permittedTiersFor } from "../routing/tier-override.js";
import { applyRoutingProfile, QueryTier, scoreConfidence } from "../routing/tiers.js";

const ALL_TIERS = [QueryTier.Simple, QueryTier.Standard, QueryTier.Complex, QueryTier.Reasoning];

const base = {
    available: ALL_TIERS,
    confidence: 0.9,
    contextTokens: 0,
};

describe("routing/policy", () => {
    describe("confidence gating", () => {
        it("refuses to downgrade on a low-confidence verdict", () => {
            const decision = decideTier({
                ...base,
                confidence: POLICY_THRESHOLDS.minConfidence - 0.01,
                current: QueryTier.Complex,
                target: QueryTier.Simple,
            });

            expect(decision.tier).toBe(QueryTier.Complex);
            expect(decision.reason).toContain("low-confidence-no-downgrade");
            expect(decision.changed).toBe(false);
        });

        it("caps a low-confidence upgrade at the uncertain ceiling", () => {
            const decision = decideTier({
                ...base,
                confidence: 0.3,
                current: QueryTier.Simple,
                target: QueryTier.Reasoning,
            });

            expect(decision.tier).toBe(POLICY_THRESHOLDS.uncertainCeiling);
            expect(decision.reason).toContain("low-confidence-capped");
        });

        it("never caps below the tier already in use", () => {
            const decision = decideTier({
                ...base,
                confidence: 0.3,
                current: QueryTier.Complex,
                target: QueryTier.Reasoning,
            });

            expect(decision.tier).toBe(QueryTier.Complex);
        });

        it("acts on a confident verdict in either direction", () => {
            expect(decideTier({ ...base, current: QueryTier.Complex, target: QueryTier.Simple }).tier).toBe(QueryTier.Simple);
            expect(decideTier({ ...base, current: QueryTier.Simple, target: QueryTier.Reasoning }).tier).toBe(QueryTier.Reasoning);
        });
    });

    describe("prompt-cache economics", () => {
        it("refuses a downgrade once the conversation is large", () => {
            const decision = decideTier({
                ...base,
                contextTokens: POLICY_THRESHOLDS.downgradeMaxContextTokens + 1,
                current: QueryTier.Complex,
                target: QueryTier.Simple,
            });

            expect(decision.tier).toBe(QueryTier.Complex);
            expect(decision.reason).toContain("downgrade-not-worth-cache-rebuild");
        });

        it("allows the same downgrade while the conversation is still small", () => {
            const decision = decideTier({
                ...base,
                contextTokens: POLICY_THRESHOLDS.downgradeMaxContextTokens - 1,
                current: QueryTier.Complex,
                target: QueryTier.Simple,
            });

            expect(decision.tier).toBe(QueryTier.Simple);
        });

        it("never blocks an upgrade on conversation size", () => {
            const decision = decideTier({
                ...base,
                contextTokens: 5_000_000,
                current: QueryTier.Simple,
                target: QueryTier.Reasoning,
            });

            expect(decision.tier).toBe(QueryTier.Reasoning);
        });
    });

    describe("availability clamping", () => {
        it("steps up when the chosen tier has no models", () => {
            const decision = decideTier({
                ...base,
                available: [QueryTier.Simple, QueryTier.Complex],
                current: null,
                target: QueryTier.Standard,
            });

            expect(decision.tier).toBe(QueryTier.Complex);
            expect(decision.reason).toContain("unavailable");
        });

        it("steps down only when nothing above is available", () => {
            const decision = decideTier({
                ...base,
                available: [QueryTier.Simple],
                current: null,
                target: QueryTier.Reasoning,
            });

            expect(decision.tier).toBe(QueryTier.Simple);
        });
    });

    describe("prompt override", () => {
        it("beats the verdict and the cache guard", () => {
            const decision = decideTier({
                ...base,
                contextTokens: 500_000,
                current: QueryTier.Complex,
                override: QueryTier.Simple,
                target: QueryTier.Complex,
            });

            expect(decision.tier).toBe(QueryTier.Simple);
            expect(decision.reason).toContain("prompt-override");
        });
    });

    it("falls back to the tier in use when nothing is available", () => {
        const decision = decideTier({ ...base, available: [], current: QueryTier.Standard, target: QueryTier.Complex });

        expect(decision.tier).toBe(QueryTier.Standard);
    });

    it("takes the verdict as-is on the first turn of a thread", () => {
        const decision = decideTier({ ...base, confidence: 0.1, current: null, target: QueryTier.Simple });

        expect(decision.tier).toBe(QueryTier.Simple);
        expect(decision.reason).toBe("initial");
    });
});

describe("routing/override", () => {
    it.each([
        ["use haiku for this", QueryTier.Simple],
        ["just use the fast model", QueryTier.Simple],
        ["switch to sonnet", QueryTier.Standard],
        ["use opus please", QueryTier.Complex],
        ["run this on the reasoning model", QueryTier.Reasoning],
        ["think harder about this one", QueryTier.Reasoning],
    ])("detects %j as %s", (text, expected) => {
        expect(detectTierOverride(text)).toBe(expected);
    });

    it.each([
        "implement a fast inverse square root",
        "the opus magnum of this codebase",
        "write a flash message component",
        "my standard approach is to cache it",
        "",
    ])("does not fire on %j", (text) => {
        expect(detectTierOverride(text)).toBeNull();
    });

    it("prefers the stronger tier when two are named", () => {
        expect(detectTierOverride("don't use haiku, use opus")).toBe(QueryTier.Complex);
    });
});

describe("routing/tiers", () => {
    describe("scoreConfidence", () => {
        it("is lowest on a tier boundary and highest mid-band", () => {
            const onBoundary = scoreConfidence(0.25);
            const midBand = scoreConfidence(0.4);

            expect(onBoundary).toBeLessThan(midBand);
        });

        it("marks a boundary score as uncertain enough for the policy to act", () => {
            expect(scoreConfidence(0.2501)).toBeLessThan(POLICY_THRESHOLDS.minConfidence);
        });

        it("stays within [0, 1] across the range", () => {
            for (let combined = 0; combined <= 1; combined += 0.01) {
                const confidence = scoreConfidence(combined);

                expect(confidence).toBeGreaterThanOrEqual(0);
                expect(confidence).toBeLessThanOrEqual(1);
            }
        });
    });

    describe("applyRoutingProfile", () => {
        it("leaves the scored tier alone on auto", () => {
            expect(applyRoutingProfile(QueryTier.Complex, "auto")).toBe(QueryTier.Complex);
        });

        it("treats premium as a floor, not a pin", () => {
            expect(applyRoutingProfile(QueryTier.Simple, "premium")).toBe(QueryTier.Complex);
            expect(applyRoutingProfile(QueryTier.Reasoning, "premium")).toBe(QueryTier.Reasoning);
        });

        it("forces the cheapest pool for the cost-shaped profiles", () => {
            for (const profile of ["eco", "free", "fast"] as const) {
                expect(applyRoutingProfile(QueryTier.Reasoning, profile)).toBe(QueryTier.Simple);
            }
        });
    });
});

describe("routing/tier-override permissions", () => {
    it("keeps the expensive pools behind a paid plan", () => {
        expect(isTierAllowedFor(QueryTier.Reasoning, "free")).toBe(false);
        expect(isTierAllowedFor(QueryTier.Reasoning, "pro")).toBe(true);
    });

    it("lists permitted tiers weakest-first", () => {
        expect(permittedTiersFor("free")).toEqual([QueryTier.Simple, QueryTier.Standard]);
        expect(permittedTiersFor("pro")).toEqual(ALL_TIERS);
    });
});

describe("routing/tier-assignment", () => {
    const candidate = (over: Partial<ModelCandidate> & { modelId: string }): ModelCandidate => {
        return {
            contextWindow: 200_000,
            costPerMillionInput: 1,
            costPerMillionOutput: 1,
            modelApiId: over.modelId,
            provider: "openrouter",
            supportsMultimodal: false,
            supportsTools: true,
            ...over,
        };
    };

    it("lets a cheap reasoning model into the everyday tiers", () => {
        const pools = computeStaticTierPools([
            candidate({ costPerMillionInput: 0.2, costPerMillionOutput: 0.4, modelId: "cheap-reasoner", supportsReasoning: true }),
            candidate({ costPerMillionInput: 20, costPerMillionOutput: 40, modelId: "pricey" }),
        ]);

        expect(pools[QueryTier.Standard]).toContain("cheap-reasoner");
    });

    it("keeps an expensive model out of the cheap tier", () => {
        const pools = computeStaticTierPools([candidate({ costPerMillionInput: 20, costPerMillionOutput: 40, modelId: "pricey" })]);

        expect(pools[QueryTier.Simple]).not.toContain("pricey");
    });

    it("honours an explicit capability flag over the model's name", () => {
        const pools = computeStaticTierPools([
            candidate({ costPerMillionInput: 0.2, costPerMillionOutput: 0.4, modelId: "o3-mini", supportsReasoning: false }),
        ]);

        // Named like a reasoning model, flagged as not one — the flag wins, so
        // it stays eligible for the tier its price belongs to.
        expect(pools[QueryTier.Simple]).toContain("o3-mini");
    });
});

describe("routing/cache", () => {
    const makeKv = () => {
        const store = new Map<string, string>();

        return {
            kv: {
                get: async (key: string) => {
                    const raw = store.get(key);

                    return raw === undefined ? null : JSON.parse(raw);
                },
                put: async (key: string, value: string) => {
                    store.set(key, value);
                },
            } as unknown as KVNamespace,
            store,
        };
    };

    const input = {
        availableTiers: ALL_TIERS,
        hasImages: false,
        lastUserMessage: "refactor the payment reconciliation job",
        toolCount: 3,
    };

    it("returns a stored verdict for the same prompt shape", async () => {
        const { kv } = makeKv();
        const cache = new VerdictCache(kv);

        await cache.put(input, { confidence: 0.8, tier: QueryTier.Complex });

        expect(await cache.get(input)).toEqual({ confidence: 0.8, tier: QueryTier.Complex });
    });

    it("does not serve a verdict graded against a different tier menu", async () => {
        const { kv } = makeKv();
        const cache = new VerdictCache(kv);

        await cache.put(input, { confidence: 0.8, tier: QueryTier.Complex });

        // A free-plan caller can only reach the bottom two tiers, so a verdict
        // produced for the full menu is not an answer to their question.
        expect(await cache.get({ ...input, availableTiers: [QueryTier.Simple, QueryTier.Standard] })).toBeNull();
    });

    it("keys on the prompt, the tool count and the attachments", async () => {
        const { kv } = makeKv();
        const cache = new VerdictCache(kv);

        await cache.put(input, { confidence: 0.8, tier: QueryTier.Complex });

        expect(await cache.get({ ...input, lastUserMessage: "something else" })).toBeNull();
        expect(await cache.get({ ...input, toolCount: 4 })).toBeNull();
        expect(await cache.get({ ...input, hasImages: true })).toBeNull();
    });

    it("stores nothing that identifies a caller", async () => {
        const { kv, store } = makeKv();
        const cache = new VerdictCache(kv);

        await cache.put(input, { confidence: 0.8, tier: QueryTier.Complex });

        // The whole point of caching the verdict rather than the finished
        // route: the artifact carries no plan, filter rules or pins, so it
        // cannot leak one caller's restrictions into another's request.
        for (const [key, value] of store) {
            expect(key.startsWith("verdict:")).toBe(true);
            expect(Object.keys(JSON.parse(value)).toSorted((a, b) => a.localeCompare(b))).toEqual(["confidence", "tier"]);
        }
    });
});
