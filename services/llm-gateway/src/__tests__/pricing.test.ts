import { describe, expect, it } from "vitest";

import type { ModelPricing, TokenUsage } from "../providers/pricing.js";
import { calculateCost } from "../providers/pricing.js";

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
