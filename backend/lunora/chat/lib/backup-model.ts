import { MODEL_LOOKUP, type ModelDefinition } from "@neore/ai/models";

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
