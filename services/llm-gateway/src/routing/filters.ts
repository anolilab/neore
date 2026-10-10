/**
 * Model filter rules and filtering engine.
 *
 * Enforces user/org-level restrictions on which models can be used,
 * based on geographic regions, model IDs, provider names, and privacy settings.
 */
import type { ModelCandidate } from "./selector.js";

/**
 * User-configurable model filter rules.
 *
 * Passed from the backend (stored on `aiUserPreferences.modelFilterRules`)
 * to the gateway on every route/stream/generate request.
 */
export interface ModelFilterRules {
    /** Only allow these model IDs. If set, all other models are blocked. */
    allowedModels?: string[];
    /** Only allow these providers (e.g., "google", "openrouter"). */
    allowedProviders?: string[];
    /** Only allow models hosted in these regions. Empty/undefined = no restriction. */
    allowedRegions?: string[];
    /** Block these model IDs. */
    blockedModels?: string[];
    /** Block these providers. */
    blockedProviders?: string[];
    /** Block models hosted in these regions. */
    blockedRegions?: string[];
    /** Deny providers that collect/train on data. */
    denyDataCollection?: boolean;
    /** Require zero data retention from the provider. */
    requireZDR?: boolean;
}

/**
 * Check whether a single model candidate passes the filter rules.
 *
 * Returns `null` if allowed, or a human-readable rejection reason if blocked.
 */
export const getModelRejectionReason = (candidate: ModelCandidate, rules: ModelFilterRules): string | null => {
    // Model ID allow-list (strict: only these models are usable)
    if (rules.allowedModels && rules.allowedModels.length > 0 && !rules.allowedModels.includes(candidate.modelId)) {
        return `Model "${candidate.modelId}" is not in the allowed models list`;
    }

    // Model ID block-list
    if (rules.blockedModels && rules.blockedModels.length > 0 && rules.blockedModels.includes(candidate.modelId)) {
        return `Model "${candidate.modelId}" is blocked`;
    }

    // Provider allow-list
    if (rules.allowedProviders && rules.allowedProviders.length > 0 && !rules.allowedProviders.includes(candidate.provider)) {
        return `Provider "${candidate.provider}" is not in the allowed providers list`;
    }

    // Provider block-list
    if (rules.blockedProviders && rules.blockedProviders.length > 0 && rules.blockedProviders.includes(candidate.provider)) {
        return `Provider "${candidate.provider}" is blocked`;
    }

    // Region allow-list: model must have at least one region that matches
    if (rules.allowedRegions && rules.allowedRegions.length > 0) {
        const modelRegions = candidate.regions ?? [];

        if (modelRegions.length === 0) {
            return `Model "${candidate.modelId}" has no known region and allowed regions are set`;
        }

        const hasAllowedRegion = modelRegions.some((r) => rules.allowedRegions!.includes(r));

        if (!hasAllowedRegion) {
            return `Model "${candidate.modelId}" regions [${modelRegions.join(", ")}] do not match allowed regions [${rules.allowedRegions.join(", ")}]`;
        }
    }

    // Region block-list: model must NOT have ALL its regions blocked
    if (rules.blockedRegions && rules.blockedRegions.length > 0) {
        const modelRegions = candidate.regions ?? [];

        if (modelRegions.length > 0) {
            const allBlocked = modelRegions.every((r) => rules.blockedRegions!.includes(r));

            if (allBlocked) {
                return `Model "${candidate.modelId}" regions [${modelRegions.join(", ")}] are all in blocked regions [${rules.blockedRegions.join(", ")}]`;
            }
        }
    }

    return null;
};

/**
 * Check whether a single model candidate is allowed by the filter rules.
 */
export const isModelAllowed = (candidate: ModelCandidate, rules: ModelFilterRules): boolean => getModelRejectionReason(candidate, rules) === null;

/**
 * Filter a list of model candidates by the given rules.
 * Returns only the models that pass all filter checks.
 */
export const filterModels = (candidates: ModelCandidate[], rules: ModelFilterRules): ModelCandidate[] => candidates.filter((c) => isModelAllowed(c, rules));

/**
 * Check if the rules object has any active filters.
 */
export const hasActiveFilters = (rules: ModelFilterRules | undefined): rules is ModelFilterRules => {
    if (!rules) return false;

    return (
        (rules.allowedRegions !== undefined && rules.allowedRegions.length > 0) ||
        (rules.blockedRegions !== undefined && rules.blockedRegions.length > 0) ||
        (rules.allowedModels !== undefined && rules.allowedModels.length > 0) ||
        (rules.blockedModels !== undefined && rules.blockedModels.length > 0) ||
        (rules.allowedProviders !== undefined && rules.allowedProviders.length > 0) ||
        (rules.blockedProviders !== undefined && rules.blockedProviders.length > 0) ||
        rules.requireZDR === true ||
        rules.denyDataCollection === true
    );
};
