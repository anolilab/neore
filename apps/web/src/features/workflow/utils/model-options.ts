import type { GatewayModel } from "@neore/ai/models";

const MODEL_ID_SEPARATOR_RE = /[/:]/;

/**
 * Extract a short display name from a model ID.
 *
 * Examples:
 *   "fal-ai/flux/dev/image-to-image" → "image-to-image"
 *   "fal:flux-dev"                   → "flux-dev"
 *   "claude-opus-4-6"               → "claude-opus-4-6".
 */
export const getShortModelName = (modelId: string): string => modelId.split(MODEL_ID_SEPARATOR_RE).pop() ?? modelId;

/**
 * Resolve a human-readable label for a model ID.
 * Checks the provided model list first, falls back to the short name.
 * `fallback` (already translated) is shown when no model is set.
 */
export const getModelLabel = (modelId: string | undefined, models: GatewayModel[], fallback = "Model"): string => {
    if (!modelId) {
        return fallback;
    }

    const registryModel = models.find((m) => m.id === modelId);

    if (registryModel?.name) {
        return registryModel.name;
    }

    return getShortModelName(modelId);
};

/** Base option shape shared by all workflow node model selects */
export interface BaseModelOption {
    isPremium?: boolean;
    label: string;
    value: string;
}

/**
 * Convert a GatewayModel (or compatible object) to a base { label, value, isPremium } option.
 * Nodes that need extra fields can spread the result and add their own.
 */
export const toBaseOption = (m: { id: string; isPremium?: boolean; name?: string }): BaseModelOption => {
    return {
        isPremium: m.isPremium,
        label: m.name ?? m.id,
        value: m.id,
    };
};
