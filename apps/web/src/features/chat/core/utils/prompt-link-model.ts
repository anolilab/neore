import type { ModelDefinition } from "@neore/ai/models";
import { enabledModelOf } from "@neore/ai/models";

import type { ComposerMode } from "../stores/model-store";
import { composerModelOf } from "./composer-model";

/**
 * The registry row a link can name: an enabled text model the composer picks, and not an external one. Both ends use it, so a
 * link is copied only with a model the link opens on. A custom endpoint's model is not in the registry, so it has no row here.
 *
 * Kept out of `prompt-link.ts`: the chat route's search parser imports that module and runs in the entry chunk, and the model
 * registry this module needs would otherwise be loaded there too.
 */
export const carriableLinkModel = (model: string | undefined): ModelDefinition | undefined => {
    const definition = enabledModelOf(model, { mode: "text" });

    return definition?.provider === "external" ? undefined : definition;
};

/**
 * Whether opening a link on `model` selects it for the new chat. This is the one rule the link's open applies (the draft hook) and
 * its copy checks: the new chat is a text chat, the picker offers the model to this user (`allowedModelIds`), and the composer
 * would send with it (an anonymous visitor's text chat sends the free model). A copy names a model only when this holds.
 */
export const linkModelAppliesOnOpen = ({
    allowedModelIds,
    isAnonymous,
    model,
    newThreadMode,
}: {
    allowedModelIds: ReadonlySet<string>;
    isAnonymous: boolean;
    model: string | undefined;
    newThreadMode: ComposerMode;
}): boolean => {
    const definition = carriableLinkModel(model);

    return (
        definition !== undefined &&
        newThreadMode === "text" &&
        allowedModelIds.has(definition.id) &&
        composerModelOf({ isAnonymous, mode: "text", threadModel: definition.id }) === definition.id
    );
};
