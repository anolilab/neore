import { MODEL_LOOKUP } from "./registry";
import type { ModelDefinition } from "./types";

/** What an action accepts from a caller's model id. */
export interface ModelAccepts {
    /** A boolean capability flag the row must carry, such as `supportsUpscale`. */
    capability?: Extract<keyof ModelDefinition, `supports${string}`>;
    mode: NonNullable<ModelDefinition["mode"]>;
    /** Only for actions that call one provider's API directly. */
    provider?: ModelDefinition["provider"];
}

/** The FAL image endpoints the edit and workflow actions call directly. */
export const FAL_IMAGE: ModelAccepts = { mode: "image", provider: "fal" };

/** The FAL video endpoints the video actions call directly. */
export const FAL_VIDEO: ModelAccepts = { mode: "video", provider: "fal" };

/**
 * The registry row a set model id names, when it is enabled and matches what the action accepts. An unset id
 * is `undefined`: a caller resolves its default first (`resolveWorkflowModel`), so a default is never silently
 * exempt. A disabled row is hidden everywhere, so an action must not run it for a caller who names it.
 */
export const enabledModelOf = (model: string | undefined, accepts: ModelAccepts): ModelDefinition | undefined => {
    if (model === undefined) {
        return undefined;
    }

    const definition = MODEL_LOOKUP.get(model);

    if (definition?.mode !== accepts.mode || definition.enabled === false) {
        return undefined;
    }

    if (accepts.provider !== undefined && definition.provider !== accepts.provider) {
        return undefined;
    }

    if (accepts.capability !== undefined && definition[accepts.capability] !== true) {
        return undefined;
    }

    return definition;
};
