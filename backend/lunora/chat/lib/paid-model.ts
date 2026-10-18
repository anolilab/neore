/**
 * The paid-model rule that needs no context: which refusal a run gets, and whether the user's own key
 * can pay for a model at all. Pure, so the workflow's video policy and the chat run gate share one answer.
 */
import type { ModelDefinition } from "@neore/ai/models";

/**
 * Whether the user's own key can pay for `definition`'s call. Only a text run uses the user's keys, and
 * fal is never paid with one: its media actions (image, video, audio) call it with the platform key.
 */
export const byokPaysFor = (definition: ModelDefinition): boolean => (definition.mode ?? "text") === "text" && definition.provider !== "fal";

/**
 * The refusal for a paid-plan model a run may not use. One sentence on every path (chat, the video
 * actions, the workflow pre-check), so a model is refused in the same words wherever it is picked.
 * `byokCanHelp` names the Settings route only when the user's own key would let the run through.
 */
export const paidModelRefusal = (name: string, byokCanHelp: boolean): string =>
    byokCanHelp
        ? `${name} needs a Pro plan. Pick a free model, upgrade, or add your own API key for this provider in Settings.`
        : `${name} needs a Pro plan. Pick a free model or upgrade.`;
