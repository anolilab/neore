/**
 * Cache-write tokens are part of the prompt, so each input token is billed once: uncached at the input price,
 * read from the cache at the cache-read price, and written to the cache at the cache-write price.
 */
import { describe, expect, it } from "vitest";

import { extractTokenCounts } from "../lib/token-counter.js";
import type { ModelPricing } from "../providers/pricing.js";
import { calculateCost, extractPricing } from "../providers/pricing.js";

const PRICING: ModelPricing = {
    cachedInputPerMillion: 0.25,
    cacheWritePerMillion: 5,
    inputPerMillion: 2.5,
    outputPerMillion: 10,
};

describe("calculateCost with cache writes", () => {
    it("bills cache writes at the cache-write price and keeps them out of uncached input", () => {
        // 1000 prompt tokens: 600 read, 300 written, 100 uncached. 100 * 2.5 + 600 * 0.25 + 300 * 5 = 1900 microdollars.
        expect(calculateCost(PRICING, { cachedTokens: 600, cacheWriteTokens: 300, completionTokens: 0, promptTokens: 1000 })).toBe(1900);
    });

    it("falls back to the input price for cache writes when the model has no cache-write price", () => {
        const noWritePrice: ModelPricing = { cachedInputPerMillion: 0.25, inputPerMillion: 2.5, outputPerMillion: 10 };

        // 700 uncached and 300 written, both at 2.5: 1750 + 750 = 2500 microdollars.
        expect(calculateCost(noWritePrice, { cacheWriteTokens: 300, completionTokens: 0, promptTokens: 1000 })).toBe(2500);
    });

    it("costs the same as before when no cache writes are reported", () => {
        const withoutWrites = calculateCost(PRICING, { cachedTokens: 600, completionTokens: 0, promptTokens: 1000 });
        const zeroWrites = calculateCost(PRICING, { cachedTokens: 600, cacheWriteTokens: 0, completionTokens: 0, promptTokens: 1000 });

        expect(zeroWrites).toBe(withoutWrites);
    });
});

describe("extractPricing cache-write price", () => {
    it("reads cache_write from models.dev", () => {
        const data = {
            anthropic: { models: { "claude-sonnet-4-5": { cost: { cache_read: 0.3, cache_write: 3.75, input: 3, output: 15 } } } },
        };

        expect(extractPricing(data, "claude-sonnet-4-5", "anthropic")).toMatchObject({ cacheWritePerMillion: 3.75 });
    });
});

describe("extractTokenCounts", () => {
    it("reads the cache-write count from the SDK input token details", () => {
        const counts = extractTokenCounts({
            inputTokenDetails: { cacheReadTokens: 600, cacheWriteTokens: 300 },
            inputTokens: 1000,
            outputTokens: 5,
        } as never);

        expect(counts).toMatchObject({ cachedTokens: 600, cacheWriteTokens: 300, promptTokens: 1000 });
    });
});
