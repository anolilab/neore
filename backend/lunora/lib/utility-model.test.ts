/**
 * The background model follows the user's model filter rules: it is the first candidate the rules allow, the rules
 * reach the gateway (where `requireZDR` / `denyDataCollection` shape provider routing), and when no candidate is
 * allowed the call refuses with a typed error instead of falling back to a forbidden model.
 */
import { DEFAULT_MEMORY_EXTRACTION_MODEL } from "@neore/ai/constants";
import { describe, expect, it, vi } from "vitest";

import { getUtilityModel, NoAllowedUtilityModelError, pickUtilityModelId, UTILITY_FALLBACK_MODELS } from "./utility-model";

vi.mock("@neore/ai/providers", async () => {
    const { MODEL_REGISTRY } = await import("@neore/ai/models");

    return { buildAgents: () => Object.fromEntries(MODEL_REGISTRY.map((model) => [model.id, { chat: { modelId: model.id } }])) };
});

const gateway = async () => new Response("{}");
const configOf = (model: unknown) => (model as { config: { modelFilterRules?: unknown; modelId: string; userId: string } }).config;

describe("pickUtilityModelId", () => {
    it("keeps the default when the user set no rules", () => {
        expect(pickUtilityModelId(undefined)).toBe(DEFAULT_MEMORY_EXTRACTION_MODEL);
        expect(pickUtilityModelId({})).toBe(DEFAULT_MEMORY_EXTRACTION_MODEL);
    });

    it("takes the next allowed candidate when the rules exclude the default", () => {
        expect(pickUtilityModelId({ blockedModels: [DEFAULT_MEMORY_EXTRACTION_MODEL] })).toBe(UTILITY_FALLBACK_MODELS[0]);
        expect(pickUtilityModelId({ blockedModels: [DEFAULT_MEMORY_EXTRACTION_MODEL, UTILITY_FALLBACK_MODELS[0]!] })).toBe(UTILITY_FALLBACK_MODELS[1]);
    });

    it("judges candidates by their hosting regions, as the chat model gate does", () => {
        const picked = pickUtilityModelId({ allowedRegions: ["CN"] });

        expect(picked).toBeUndefined();
        expect(pickUtilityModelId({ allowedRegions: ["EU"] })).toBe(DEFAULT_MEMORY_EXTRACTION_MODEL);
    });

    it("answers nothing when the rules exclude every candidate", () => {
        expect(pickUtilityModelId({ allowedModels: ["some/other-model"] })).toBeUndefined();
    });

    it("never leaves the named model when strict", () => {
        expect(pickUtilityModelId({ blockedModels: [DEFAULT_MEMORY_EXTRACTION_MODEL] }, DEFAULT_MEMORY_EXTRACTION_MODEL, true)).toBeUndefined();
    });
});

describe("getUtilityModel", () => {
    it("builds the default model, with no rules, for a call without a user", async () => {
        const model = await getUtilityModel(gateway);

        expect(configOf(model)).toMatchObject({ modelId: DEFAULT_MEMORY_EXTRACTION_MODEL, userId: "system" });
        expect(configOf(model).modelFilterRules).toBeUndefined();
    });

    it("builds the next allowed model and hands the rules to the gateway", async () => {
        const rules = { blockedModels: [DEFAULT_MEMORY_EXTRACTION_MODEL], requireZDR: true };
        const model = await getUtilityModel(gateway, { rules, userId: "user-1" });

        expect(configOf(model)).toMatchObject({ modelFilterRules: rules, modelId: UTILITY_FALLBACK_MODELS[0], userId: "user-1" });
    });

    it("hands a privacy rule to the gateway even though it does not exclude the default", async () => {
        const model = await getUtilityModel(gateway, { rules: { denyDataCollection: true }, userId: "user-1" });

        expect(configOf(model)).toMatchObject({ modelFilterRules: { denyDataCollection: true }, modelId: DEFAULT_MEMORY_EXTRACTION_MODEL });
    });

    it("refuses with the typed error when the rules exclude every candidate", async () => {
        await expect(getUtilityModel(gateway, { rules: { allowedModels: ["some/other-model"] }, userId: "user-1" })).rejects.toBeInstanceOf(
            NoAllowedUtilityModelError,
        );
    });

    it("refuses a strict call whose named model is excluded, rather than substituting another", async () => {
        await expect(
            getUtilityModel(gateway, { rules: { blockedModels: [DEFAULT_MEMORY_EXTRACTION_MODEL] }, userId: "user-1" }, DEFAULT_MEMORY_EXTRACTION_MODEL, {
                strict: true,
            }),
        ).rejects.toBeInstanceOf(NoAllowedUtilityModelError);
    });
});
