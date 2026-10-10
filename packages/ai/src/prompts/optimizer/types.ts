/**
 * Prompt-optimizer types.
 *
 * Ported (with attribution) from linshenkx/prompt-optimizer (MIT).
 * https://github.com/linshenkx/prompt-optimizer
 */

export type OptimizerKind = "user" | "system" | "iterate";

/** User-prompt optimization styles. */
export type UserOptimizerStyle = "basic" | "professional" | "planning";

/** System-prompt optimization styles. */
export type SystemOptimizerStyle = "general" | "analytical" | "output-format";

/** Any optimizer style. Used when the caller doesn't care to discriminate. */
export type OptimizerStyle = UserOptimizerStyle | SystemOptimizerStyle | "iterate";

export interface OptimizerMessage {
    /** Mustache-style content. Supports `{{var}}` and `{{#helpers.toJson}}{{{var}}}{{/helpers.toJson}}`. */
    content: string;
    role: "system" | "user";
}

export interface OptimizerTemplate {
    description: string;
    id: OptimizerStyle;
    kind: OptimizerKind;
    messages: [OptimizerMessage, OptimizerMessage];
    name: string;
}
