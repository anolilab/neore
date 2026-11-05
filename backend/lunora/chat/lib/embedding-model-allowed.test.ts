/**
 * The memory and knowledge embeddings run on Workers AI, which the gateway refuses under any region rule and under
 * zero data retention or no data collection. Callers check first, so knowledge ingest saves its chunks for keyword
 * search instead of failing the whole file.
 */
import { describe, expect, it } from "vitest";

import { embeddingModelAllowed } from "./gateway-embedding-model";

describe(embeddingModelAllowed, () => {
    it("allows the embedding model without rules, or with rules it passes", () => {
        expect(embeddingModelAllowed(undefined)).toBe(true);
        expect(embeddingModelAllowed({})).toBe(true);
        expect(embeddingModelAllowed({ blockedModels: ["openai/o3"] })).toBe(true);
    });

    it("refuses it under a region rule or a privacy rule", () => {
        expect(embeddingModelAllowed({ allowedRegions: ["EU"] })).toBe(false);
        expect(embeddingModelAllowed({ blockedRegions: ["CN"] })).toBe(false);
        expect(embeddingModelAllowed({ requireZDR: true })).toBe(false);
        expect(embeddingModelAllowed({ denyDataCollection: true })).toBe(false);
        expect(embeddingModelAllowed({ blockedProviders: ["cloudflare"] })).toBe(false);
    });
});
