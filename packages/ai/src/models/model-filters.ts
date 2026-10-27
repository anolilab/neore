/**
 * Model filter rules and filtering engine.
 *
 * Enforces user/org-level restrictions on which models can be used,
 * based on geographic regions, model IDs, provider names, and privacy settings.
 */
/** What a filter reads of a model: its id, provider and hosting regions. */
export interface FilterableModel {
    modelId: string;
    provider: string;
    regions?: string[];
}

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
export const getModelRejectionReason = (candidate: FilterableModel, rules: ModelFilterRules): string | null => {
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
export const isModelAllowed = (candidate: FilterableModel, rules: ModelFilterRules): boolean => getModelRejectionReason(candidate, rules) === null;

/**
 * Filter a list of model candidates by the given rules.
 * Returns only the models that pass all filter checks.
 */
export const filterModels = <T extends FilterableModel>(candidates: T[], rules: ModelFilterRules): T[] => candidates.filter((c) => isModelAllowed(c, rules));

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

/** Data-processing regions a model is hosted in, derived from its provider (the gateway catalog stamps this on every model). */
export const deriveModelRegions = (model: { modelApiId: string; provider: string }): string[] => {
    const { modelApiId, provider } = model;

    // Direct providers
    if (provider === "google") return ["US", "EU"];

    if (provider === "groq") return ["US"];

    if (provider === "xai") return ["US"];

    if (provider === "fal") return ["US"]; // FAL runs on US infrastructure

    if (provider === "openai") return ["US"];

    if (provider === "klingai") return ["CN", "US"];

    if (provider === "luma") return ["US"];

    if (provider === "replicate") return ["US"];

    if (provider === "fireworks") return ["US"];

    if (provider === "bfl") return ["EU", "US"]; // Black Forest Labs (Germany)

    // OpenRouter/Requesty: derive from underlying model provider
    const apiPrefix = modelApiId.split("/", 1)[0]?.toLowerCase() ?? "";
    const prefixRegionMap: Record<string, string[]> = {
        "alibaba-cloud": ["CN", "US"],
        anthropic: ["US", "EU"],
        bytedance: ["CN", "US"],
        cohere: ["US", "CA"],
        deepseek: ["CN", "US"],
        google: ["US", "EU"],
        "meta-llama": ["US"],
        microsoft: ["US"],
        mistralai: ["EU", "US"],
        moonshotai: ["CN", "US"],
        nousresearch: ["US"],
        nvidia: ["US"],
        openai: ["US"],
        "perplexity-ai": ["US"],
        qwen: ["CN", "US"],
    };
    const mapped = prefixRegionMap[apiPrefix];

    if (mapped) return mapped;

    return ["US"];
};
