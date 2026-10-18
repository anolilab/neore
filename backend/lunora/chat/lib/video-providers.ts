import type { ModelDefinition } from "@neore/ai/models";

/**
 * The providers the text-to-video action calls. The workflow pre-check reads the same list, so a node
 * on any other provider is refused before a frame is extracted or a quota unit is spent.
 */
export const TEXT_TO_VIDEO_PROVIDERS: ReadonlyArray<ModelDefinition["provider"]> = ["fal", "openrouter"];
