import { describe, expect, it } from "vitest";

import type { AppEnv } from "../env.js";
import type { ModelPricing, ModelsDevelopmentData, TokenUsage } from "../providers/pricing.js";
import { calculateCost, extractPricing, PricingService } from "../providers/pricing.js";
import sample from "./fixtures/models-dev.sample.json";
import { createMockEnv, MockKVNamespace } from "./helpers/mock-env.js";

const fixture: ModelsDevelopmentData = sample;

describe("calculateCost", () => {
    const GPT4O_PRICING: ModelPricing = {
        inputPerMillion: 2.5,
        outputPerMillion: 10,
    };

    it("calculates basic input + output cost", () => {
        const usage: TokenUsage = {
            completionTokens: 500,
            promptTokens: 1000,
        };

        // Input: 1000/1M * $2.5 = $0.0025 = 2500 microdollars
        // Output: 500/1M * $10.0 = $0.005 = 5000 microdollars
        // Total: 7500 microdollars
        expect(calculateCost(GPT4O_PRICING, usage)).toBe(7500);
    });

    it("applies cached input pricing discount", () => {
        const pricing: ModelPricing = {
            cachedInputPerMillion: 1.5, // 50% discount
            inputPerMillion: 3,
            outputPerMillion: 15,
        };
        const usage: TokenUsage = {
            cachedTokens: 1000,
            completionTokens: 100,
            promptTokens: 2000,
        };

        // Regular input: (2000 - 1000)/1M * $3.0 = $0.003 = 3000µ
        // Cached input: 1000/1M * $1.5 = $0.0015 = 1500µ
        // Output: 100/1M * $15.0 = $0.0015 = 1500µ
        // Total: 6000µ
        expect(calculateCost(pricing, usage)).toBe(6000);
    });

    it("applies reasoning token pricing", () => {
        const pricing: ModelPricing = {
            inputPerMillion: 15,
            outputPerMillion: 60,
            reasoningOutputPerMillion: 60,
        };
        const usage: TokenUsage = {
            completionTokens: 200,
            promptTokens: 100,
            reasoningTokens: 300,
        };

        // Input: 100/1M * $15 = $0.0015 = 1500µ
        // Output: 200/1M * $60 = $0.012 = 12000µ
        // Reasoning: 300/1M * $60 = $0.018 = 18000µ
        // Total: 31500µ
        expect(calculateCost(pricing, usage)).toBe(31_500);
    });

    it("falls back to outputPerMillion for reasoning when reasoningOutputPerMillion not set", () => {
        const pricing: ModelPricing = {
            inputPerMillion: 3,
            outputPerMillion: 15,
        };
        const usage: TokenUsage = {
            completionTokens: 0,
            promptTokens: 0,
            reasoningTokens: 1_000_000,
        };

        // Reasoning: 1M/1M * $15 = $15 = 15,000,000µ
        expect(calculateCost(pricing, usage)).toBe(15_000_000);
    });

    it("returns 0 for zero token usage", () => {
        const usage: TokenUsage = {
            completionTokens: 0,
            promptTokens: 0,
        };

        expect(calculateCost(GPT4O_PRICING, usage)).toBe(0);
    });

    it("rounds to nearest integer microdollar", () => {
        const pricing: ModelPricing = {
            inputPerMillion: 1,
            outputPerMillion: 1,
        };
        const usage: TokenUsage = {
            completionTokens: 0,
            promptTokens: 1, // 1/1M * $1 = $0.000001 = 1µ
        };

        expect(calculateCost(pricing, usage)).toBe(1);
    });

    it("handles large token counts without overflow", () => {
        const pricing: ModelPricing = {
            inputPerMillion: 2.5,
            outputPerMillion: 10,
        };
        const usage: TokenUsage = {
            completionTokens: 500_000,
            promptTokens: 1_000_000,
        };

        // Input: 1M/1M * $2.5 = $2.5 = 2,500,000µ
        // Output: 0.5M/1M * $10 = $5 = 5,000,000µ
        // Total: 7,500,000µ
        expect(calculateCost(pricing, usage)).toBe(7_500_000);
    });
});

describe("extractPricing (provider-keyed models.dev document)", () => {
    it("prices a bare model id in USD per million tokens, skipping a provider that lists it without a cost", () => {
        expect(extractPricing(fixture, "claude-sonnet-4-5")).toStrictEqual({
            cachedInputPerMillion: 0.3,
            contextWindow: 200_000,
            inputPerMillion: 3,
            outputPerMillion: 15,
        });
    });

    it.each(["anthropic/claude-sonnet-4-5", "anthropic:claude-sonnet-4-5", "claude-sonnet-4-5/"])("resolves %s like the bare id", (id) => {
        expect(extractPricing(fixture, id)).toStrictEqual(extractPricing(fixture, "claude-sonnet-4-5"));
    });

    it("prefers the hinted provider", () => {
        expect(extractPricing(fixture, "gpt-5-mini", "openai")).toMatchObject({ inputPerMillion: 0.25, outputPerMillion: 2 });
    });

    describe("two providers list one model id at different prices", () => {
        const twoProviders: ModelsDevelopmentData = {
            freeHost: { models: { "shared-model": { cost: { input: 0, output: 0 } } } },
            paidHost: { models: { "shared-model": { cost: { input: 4, output: 8 } } } },
        };

        it("bills the hinted provider's explicit free price, not another provider's paid one", () => {
            expect(extractPricing(twoProviders, "shared-model", "freeHost")).toMatchObject({ inputPerMillion: 0, outputPerMillion: 0 });
        });

        it("never takes a zero price from a provider the hint did not name", () => {
            expect(extractPricing(twoProviders, "shared-model")).toMatchObject({ inputPerMillion: 4, outputPerMillion: 8 });
        });

        it("does not bill a zero price from the prefix's provider when another provider serves the hinted call", () => {
            const reseller: ModelsDevelopmentData = {
                openai: { models: { foo: { cost: { input: 0, output: 0 } } } },
                openrouter: { models: {} },
                other: { models: { "openai/foo": { cost: { input: 2, output: 4 } } } },
            };

            expect(extractPricing(reseller, "openai/foo", "openrouter")).toMatchObject({ inputPerMillion: 2, outputPerMillion: 4 });
        });
    });

    it("falls through an unknown provider hint", () => {
        expect(extractPricing(fixture, "gpt-5", "custom")).toMatchObject({ inputPerMillion: 1.25, outputPerMillion: 10 });
    });

    it("resolves an OpenRouter slash id, by full key and by suffix", () => {
        const expected = { contextWindow: 1_310_720, inputPerMillion: 0.1, outputPerMillion: 0.3 };

        expect(extractPricing(fixture, "meta-llama/llama-4-scout")).toStrictEqual(expected);
        expect(extractPricing(fixture, "llama-4-scout")).toStrictEqual(expected);
    });

    it("maps a reasoning price", () => {
        expect(extractPricing(fixture, "deepseek/deepseek-v4-pro")).toMatchObject({ reasoningOutputPerMillion: 1.98 });
    });

    it("returns null for an unknown id", () => {
        expect(extractPricing(fixture, "no-such-model")).toBeNull();
        expect(extractPricing(fixture, "/")).toBeNull();
    });

    it("returns null for a model without a cost", () => {
        expect(extractPricing(fixture, "openrouter/auto")).toBeNull();
    });

    it("feeds calculateCost at the right scale", () => {
        // An unpriced model would cost 0 here and fail the assertion.
        const pricing = extractPricing(fixture, "gpt-5") ?? { inputPerMillion: 0, outputPerMillion: 0 };

        // 1M prompt tokens at $1.25 / M = $1.25 = 1,250,000 µ$
        expect(calculateCost(pricing, { completionTokens: 0, promptTokens: 1_000_000 })).toBe(Math.round(1.25 * 1_000_000));
    });
});

describe("PricingService.getPricing cache", () => {
    it("keys the per-model cache by provider, so one provider's price never pins another's", async () => {
        expect.assertions(3);

        const pricingKv = new MockKVNamespace();
        const document: ModelsDevelopmentData = {
            "provider-a": { models: { "same-model": { cost: { input: 1, output: 2 } } } },
            "provider-b": { models: { "same-model": { cost: { input: 5, output: 10 } } } },
        };

        await pricingKv.put("models_dev_full", JSON.stringify(document));

        const service = new PricingService(createMockEnv({ pricingKv }) as unknown as AppEnv);

        await expect(service.getPricing("same-model", "provider-a")).resolves.toStrictEqual({ inputPerMillion: 1, outputPerMillion: 2 });
        await expect(service.getPricing("same-model", "provider-b")).resolves.toStrictEqual({ inputPerMillion: 5, outputPerMillion: 10 });

        const { keys } = await pricingKv.list({ prefix: "pricing:" });

        expect(keys.map((key) => key.name).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "pricing:v2:provider-a:same-model",
            "pricing:v2:provider-b:same-model",
        ]);
    });
});
