import type { ModelDefinition } from "@neore/ai/models";
import { enabledModelOf } from "@neore/ai/models";

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
