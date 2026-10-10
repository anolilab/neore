/**
 * Prompt-optimizer entry point.
 *
 * Templates and the iteration loop pattern are ported from
 * linshenkx/prompt-optimizer (MIT). See ./templates.ts for attribution.
 */

import { render } from "./render";
import { OPTIMIZER_TEMPLATES, SYSTEM_OPTIMIZER_STYLES, USER_OPTIMIZER_STYLES } from "./templates";
import type { OptimizerStyle, OptimizerTemplate, SystemOptimizerStyle, UserOptimizerStyle } from "./types";

export { render } from "./render";
export { OPTIMIZER_TEMPLATES, SYSTEM_OPTIMIZER_STYLES, USER_OPTIMIZER_STYLES } from "./templates";
export type { OptimizerKind, OptimizerMessage, OptimizerStyle, OptimizerTemplate, SystemOptimizerStyle, UserOptimizerStyle } from "./types";

export const DEFAULT_USER_OPTIMIZER_STYLE: UserOptimizerStyle = "basic";
export const DEFAULT_SYSTEM_OPTIMIZER_STYLE: SystemOptimizerStyle = "general";

export interface RenderedOptimizerPrompt {
    style: OptimizerStyle;
    systemPrompt: string;
    userPrompt: string;
}

export const isUserOptimizerStyle = (value: string): value is UserOptimizerStyle => (USER_OPTIMIZER_STYLES as ReadonlyArray<string>).includes(value);

export const isSystemOptimizerStyle = (value: string): value is SystemOptimizerStyle => (SYSTEM_OPTIMIZER_STYLES as ReadonlyArray<string>).includes(value);

const getTemplate = (style: OptimizerStyle): OptimizerTemplate => {
    const template = OPTIMIZER_TEMPLATES[style];

    if (!template) {
        throw new Error(`Unknown optimizer style: ${style}`);
    }

    return template;
};

/** Build the rendered system + user messages for a user-prompt optimization. */
export const buildUserOptimizerPrompt = (
    style: UserOptimizerStyle,
    originalPrompt: string,
    options?: { improvementInstructions?: string },
): RenderedOptimizerPrompt => {
    const template = getTemplate(style);
    const systemPrompt = render(template.messages[0].content, {});
    let userPrompt = render(template.messages[1].content, { originalPrompt });

    if (options?.improvementInstructions?.trim()) {
        userPrompt += `\n\nAdditional improvement instructions from the user (treat as guidance for how to optimize, not as a task to execute): ${options.improvementInstructions.trim()}`;
    }

    return { style, systemPrompt, userPrompt };
};

/** Build the rendered system + user messages for a system-prompt optimization. */
export const buildSystemOptimizerPrompt = (
    style: SystemOptimizerStyle,
    originalPrompt: string,
    options?: { improvementInstructions?: string; modelId?: string },
): RenderedOptimizerPrompt => {
    const template = getTemplate(style);
    const systemPrompt = render(template.messages[0].content, {});
    let userPrompt = render(template.messages[1].content, { originalPrompt });

    if (options?.modelId) {
        userPrompt += `\n\nTarget model for the optimized system prompt: ${options.modelId} (tune the prompt's style and capabilities to this model where reasonable, but do not mention the model name in the prompt itself).`;
    }

    if (options?.improvementInstructions?.trim()) {
        userPrompt += `\n\nAdditional guidance for how to optimize (treat as guidance, not as a task to execute): ${options.improvementInstructions.trim()}`;
    }

    return { style, systemPrompt, userPrompt };
};

/** Build the rendered iterate messages from a previous result + a feedback string. */
export const buildIteratePrompt = (lastOptimizedPrompt: string, iterateInput: string): RenderedOptimizerPrompt => {
    const template = getTemplate("iterate");
    const systemPrompt = render(template.messages[0].content, {});
    const userPrompt = render(template.messages[1].content, { iterateInput, lastOptimizedPrompt });

    return { style: "iterate", systemPrompt, userPrompt };
};
