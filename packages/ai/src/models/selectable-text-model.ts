/** The subset of a `MODEL_REGISTRY` entry {@link isSelectableTextModel} reads. */
export interface ModelCandidate {
    enabled?: boolean;
    featureFlag?: string;
    id: string;
    isPreprocessor?: boolean;
    listed?: boolean;
    mode?: string;
    name?: string;
    provider: string;
    tier?: string;
}

/**
 * The text models a user may pick for a skill, a task or a sub-agent role: enabled, platform-hosted (not `external`,
 * not a user's `custom:` endpoint), text mode, not behind a feature flag, and listed — the same public catalogue the
 * model picker shows. Web and backend share it, so a picker never offers a model the save refuses.
 */
export const isSelectableTextModel = (definition: ModelCandidate): boolean =>
    definition.enabled !== false &&
    definition.provider !== "external" &&
    (definition.mode ?? "text") === "text" &&
    !definition.featureFlag &&
    !definition.isPreprocessor &&
    definition.listed === true &&
    !definition.id.startsWith("custom:");
