"use client";

import type { GatewayModel } from "@neore/ai/models";
import { useQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

interface ModelFilterRules {
    allowedModels?: string[];
    allowedProviders?: string[];
    allowedRegions?: string[];
    blockedModels?: string[];
    blockedProviders?: string[];
    blockedRegions?: string[];
    denyDataCollection?: boolean;
    requireZDR?: boolean;
}

/**
 * Get the regions for a model.
 * Gateway models include a `regions` field directly.
 * Falls back to provider-based heuristics for models without region data.
 */
const PROVIDER_REGIONS_FALLBACK: Record<string, string[]> = {
    anthropic: ["US", "EU"],
    google: ["US", "EU"],
    groq: ["US"],
    meta: ["US"],
    mistral: ["EU", "US"],
    openai: ["US"],
    xai: ["US"],
};

const getModelRegions = (model: GatewayModel): string[] => {
    if (model.regions && model.regions.length > 0) {
        return model.regions;
    }

    return PROVIDER_REGIONS_FALLBACK[model.provider] ?? [];
};

/**
 * Check if a model passes the filter rules.
 */
const isModelAllowed = (model: GatewayModel, rules: ModelFilterRules): boolean => {
    // Model ID allow-list
    if (rules.allowedModels && rules.allowedModels.length > 0 && !rules.allowedModels.includes(model.id)) return false;

    // Model ID block-list
    if (rules.blockedModels && rules.blockedModels.length > 0 && rules.blockedModels.includes(model.id)) return false;

    // Provider allow-list
    if (rules.allowedProviders && rules.allowedProviders.length > 0 && !rules.allowedProviders.includes(model.provider)) return false;

    // Provider block-list
    if (rules.blockedProviders && rules.blockedProviders.length > 0 && rules.blockedProviders.includes(model.provider)) return false;

    // Region allow-list
    if (rules.allowedRegions && rules.allowedRegions.length > 0) {
        const regions = getModelRegions(model);

        if (regions.length === 0) return false;

        if (regions.every((r) => !rules.allowedRegions!.includes(r))) return false;
    }

    // Region block-list
    if (rules.blockedRegions && rules.blockedRegions.length > 0) {
        const regions = getModelRegions(model);

        if (regions.length > 0 && regions.every((r) => rules.blockedRegions!.includes(r))) return false;
    }

    return true;
};

/**
 * Returns the user's model filter rules from preferences.
 */
export const useModelFilterRules = (): ModelFilterRules | undefined => {
    const crpc = useCRPC();
    const { data: aiPreferences } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));

    return aiPreferences?.modelFilterRules as ModelFilterRules | undefined;
};

/**
 * Filters a list of GatewayModels based on the user's model filter rules.
 * Returns the original list if no filter rules are configured.
 */
export const useFilteredModels = (models: GatewayModel[]): GatewayModel[] => {
    const rules = useModelFilterRules();

    if (!rules) return models;

    const hasRules =
        (rules.allowedRegions && rules.allowedRegions.length > 0) ||
        (rules.blockedRegions && rules.blockedRegions.length > 0) ||
        (rules.allowedModels && rules.allowedModels.length > 0) ||
        (rules.blockedModels && rules.blockedModels.length > 0) ||
        (rules.allowedProviders && rules.allowedProviders.length > 0) ||
        (rules.blockedProviders && rules.blockedProviders.length > 0);

    if (!hasRules) return models;

    return models.filter((m) => isModelAllowed(m, rules));
};
