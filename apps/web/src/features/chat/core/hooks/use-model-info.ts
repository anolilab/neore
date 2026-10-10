"use client";

import type { GatewayModel } from "@neore/ai/models";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import useCurrentModel from "./use-current-model";
import { useValidatedThread } from "./use-validated-thread";

interface ModelInfo {
    /** The context window size (max tokens) */
    contextWindow: number | undefined;
    /** The model ID formatted for tokenlens (e.g., "openai:gpt-4") */
    formattedModelId: string | undefined;
    /** The full model definition from the gateway models list */
    modelDefinition: GatewayModel | undefined;
    /** The raw model ID from thread or current selection */
    modelId: string | undefined;
}

// Stable identity for the "no model" case so consumers can safely put the
// result in a dependency array.
const EMPTY_MODEL_INFO: ModelInfo = {
    contextWindow: undefined,
    formattedModelId: undefined,
    modelDefinition: undefined,
    modelId: undefined,
};

/**
 * Hook to get comprehensive model information for a thread.
 * Combines the functionality of useModelId and useModelContextWindow.
 * Tries to get model from thread first, then falls back to current selected model.
 */
const useModelInfo = (threadId?: string): ModelInfo => {
    const { threadData } = useValidatedThread(threadId);
    const currentModel = useCurrentModel();
    const models = useFeatureFlaggedModels();

    // Try to get model ID from thread first, then fall back to current model
    const threadModelId = threadData?.model;
    const modelId = (threadModelId || currentModel) as string | undefined;

    if (!modelId || typeof modelId !== "string") {
        return EMPTY_MODEL_INFO;
    }

    // Find the model in the gateway models list
    const modelDefinition = models.find((m) => m.id === modelId);

    // Get context window
    const contextWindow = modelDefinition?.context_window ?? undefined;

    // Format model ID for tokenlens
    let formattedModelId: string | undefined;

    if (modelDefinition) {
        // Construct from provider and modelApiId
        if (modelDefinition.provider && modelDefinition.modelApiId) {
            formattedModelId = `${modelDefinition.provider}:${modelDefinition.modelApiId}`;
        }

        // Fallback: try to construct from provider and id
        if (!formattedModelId && modelDefinition.provider) {
            formattedModelId = `${modelDefinition.provider}:${modelId}`;
        }
    }

    // If model not found in gateway models, check if modelId already has provider prefix
    if (!formattedModelId && modelId.includes(":")) {
        formattedModelId = modelId;
    }

    // Last resort: return modelId as-is
    if (!formattedModelId) {
        formattedModelId = modelId;
    }

    return {
        contextWindow,
        formattedModelId,
        modelDefinition,
        modelId,
    };
};

export default useModelInfo;
