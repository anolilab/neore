import { describe, expect, it } from "vitest";

import { deriveModelRegions, getModelRejectionReason, GLOBAL_REGION } from "./model-filters";

const workersAi = { modelId: "cf-gpt-oss-20b", provider: "cloudflare", regions: deriveModelRegions({ modelApiId: "@cf/openai/gpt-oss-20b", provider: "cloudflare" }) };
const usAndEu = { modelId: "google/gemini-2.5-flash-lite", provider: "openrouter", regions: ["US", "EU"] };

describe("region rules for a model served from any region", () => {
    it("places Workers AI in no one region", () => {
        expect(workersAi.regions).toStrictEqual([GLOBAL_REGION]);
    });

    it("admits it while the user set no region rule", () => {
        expect(getModelRejectionReason(workersAi, {})).toBeNull();
        expect(getModelRejectionReason(workersAi, { blockedProviders: ["openrouter"] })).toBeNull();
    });

    it("refuses it under an allow-list, which it cannot keep to", () => {
        expect(getModelRejectionReason(workersAi, { allowedRegions: ["EU"] })).toContain("any region");
        expect(getModelRejectionReason(workersAi, { allowedRegions: ["US", "EU", "CN"] })).toContain("any region");
    });

    it("refuses it under a block-list, though no region it names is blocked", () => {
        expect(getModelRejectionReason(workersAi, { blockedRegions: ["CN"] })).toContain("any region");
        expect(getModelRejectionReason(usAndEu, { blockedRegions: ["CN"] })).toBeNull();
    });
});
