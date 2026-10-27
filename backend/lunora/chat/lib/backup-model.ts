import {
    deriveModelRegions,
    parseCustomModelId,
    getModelRejectionReason,
    hasActiveFilters,
    MODEL_LOOKUP,
    type ModelDefinition,
    type ModelFilterRules,
} from "@neore/ai/models";

/**
 * The registry row of the user's backup model (`userSettings.backupModel`), when
 * it can serve a chat reply in place of `primaryModel`: a known, enabled text
 * model the gateway can reach, and not the primary itself. A stored id can go
 * stale (a model is retired), so this is checked on write and again per run.
 */
export const eligibleBackupModel = (backupModel: string | undefined, primaryModel: string): ModelDefinition | undefined => {
    if (!backupModel || backupModel === primaryModel) {
        return undefined;
    }

    const definition = MODEL_LOOKUP.get(backupModel);

    if (!definition || definition.enabled === false || definition.provider === "external" || (definition.mode ?? "text") !== "text") {
        return undefined;
    }

    return definition;
};

/**
 * Why the user's model filters exclude `definition`, or `null`: the rule the gateway answers `MODEL_BLOCKED` with,
 * evaluated here so a backup the filters would refuse is not picked for a retry that could only fail.
 */
export const backupFilterRejection = (definition: ModelDefinition, rules: ModelFilterRules | undefined): string | null =>
    hasActiveFilters(rules)
        ? getModelRejectionReason({ modelId: definition.id, provider: definition.provider, regions: deriveModelRegions(definition) }, rules)
        : null;

/**
 * Whether a run on `primaryModel` can fall back at all: only a registry model served by the gateway is wrapped
 * (`getAgent`), never a custom endpoint. Backup resolution and the wrapper both ask this, so prompt sizing
 * never plans for a retry that cannot happen.
 */
export const supportsBackupFallback = (primaryModel: string): boolean => {
    if (parseCustomModelId(primaryModel)) {
        return false;
    }

    const definition = MODEL_LOOKUP.get(primaryModel);

    return definition !== undefined && definition.provider !== "external";
};
