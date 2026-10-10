/**
 * The cheap model behind every small internal call: memory extraction and
 * compression, knowledge summaries, the task verifier, the group-chat router and
 * the Agent Builder. One accessor, so each of them is metered the same way.
 */
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { DEFAULT_MEMORY_EXTRACTION_MODEL } from "@neore/ai/constants";
import type { AgentConfig } from "@neore/ai/providers";

import { GatewayLanguageModel } from "../chat/lib/gateway-language-model.js";
import type { ServiceFetch } from "./services.js";

let _agentsPromise: Promise<Record<string, AgentConfig>> | undefined;

export interface UtilityModelContext {
    threadId?: string;
    userId?: string;
}

/**
 * Returns the language model for a utility call — `DEFAULT_MEMORY_EXTRACTION_MODEL`
 * unless the caller names another registry model.
 *
 * All calls are routed through the LLM Gateway — over its service binding,
 * `gateway` (`gatewayFetch(ctx)` from the calling action) — for token counting,
 * cost tracking, and usage analytics. The optional context lets callers attach
 * userId/threadId for accurate per-user attribution.
 *
 * Uses a module-level promise cache so providers are only loaded once.
 * If the initial load fails, the cache is cleared so the next call retries —
 * preventing a permanently poisoned promise from breaking the pipeline.
 */
export const getUtilityModel = async (
    gateway: ServiceFetch,
    context?: UtilityModelContext,
    model: string = DEFAULT_MEMORY_EXTRACTION_MODEL,
): Promise<LanguageModelV3> => {
    if (!_agentsPromise) {
        _agentsPromise = import("@neore/ai/providers")
            .then(({ buildAgents }) => buildAgents())
            .catch((error: unknown) => {
                _agentsPromise = undefined; // clear so next call retries
                throw error;
            });
    }

    const agents = await _agentsPromise;
    const agent = agents[model];

    if (!agent?.chat) {
        throw new Error(`Utility model "${model}" is not available`);
    }

    // Route through LLM Gateway for token counting, cost tracking, and usage analytics.
    const { MODEL_REGISTRY } = await import("@neore/ai/models");
    const modelDefinition = MODEL_REGISTRY.find((m) => m.id === model);

    if (modelDefinition && modelDefinition.provider !== "external") {
        return new GatewayLanguageModel({
            gateway,
            modelApiId: modelDefinition.modelApiId,
            modelId: model,
            provider: modelDefinition.provider,
            threadId: context?.threadId,
            userId: context?.userId ?? "system",
        }) as unknown as LanguageModelV3;
    }

    return agent.chat as LanguageModelV3;
};
