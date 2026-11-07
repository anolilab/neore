/**
 * A run on a model the registry no longer knows falls back to the chat default. Under a region rule that default
 * (Workers AI, served from any region) is refused, so the fallback is a default the rules allow, able to read images
 * and call tools like the default.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { deriveModelRegions, getModelRejectionReason, MODEL_LOOKUP } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { NO_SERVICE_FETCH } from "../../lib/services";
import { backupCapabilities } from "./backup-model";
import getAgent from "./get-agent";

const fallbackOf = async (modelFilterRules?: Record<string, unknown>): Promise<string> => {
    const agent = await getAgent("no-such-model", { gateway: NO_SERVICE_FETCH, modelFilterRules });

    return (agent.options.languageModel as { modelId: string }).modelId;
};

describe("getAgent fallback for an unknown model", () => {
    it("is the chat default without rules", async () => {
        await expect(fallbackOf()).resolves.toBe(DEFAULT_CHAT_MODEL);
    });

    it("is a default the rules allow under a region rule, with the default's capabilities", async () => {
        const rules = { blockedRegions: ["CN"] };
        const id = await fallbackOf(rules);
        const definition = MODEL_LOOKUP.get(id)!;

        expect(id).not.toBe(DEFAULT_CHAT_MODEL);
        expect(getModelRejectionReason({ modelId: id, provider: definition.provider, regions: deriveModelRegions(definition) }, rules)).toBeNull();
        expect(backupCapabilities(definition)).toMatchObject({ images: true, tools: true });
    });
});
