import type { PromptVariable } from "./prompt-variables";
import { getAutoPopulatedVariables, replaceVariables } from "./prompt-variables";

/** The signed-in person and their organisation, as the variables that fill themselves in know them. */
export interface SavedPromptAccount {
    email?: string;
    name?: string;
    organization?: string;
}

/**
 * The composer text a saved prompt gives: its content with its variables filled in, the person's own values first and then the
 * prompt's defaults. The route decides whether a saved prompt owns the draft from this same text, and the loader writes it, so the
 * two cannot disagree about what a prompt says.
 */
export const savedPromptDraft = (prompt: { content: string; variables?: ReadonlyArray<PromptVariable> | null }, account: SavedPromptAccount): string => {
    const values: Record<string, string> = {
        ...getAutoPopulatedVariables({ email: account.email, name: account.name, organization: account.organization }),
    };
    const variables = prompt.variables ?? [];

    for (const variable of variables) {
        if (!Object.hasOwn(values, variable.name) && variable.defaultValue) {
            values[variable.name] = variable.defaultValue;
        }
    }

    return replaceVariables(prompt.content, values, { keepUnmatched: true });
};
