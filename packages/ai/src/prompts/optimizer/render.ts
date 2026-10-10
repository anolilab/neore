/**
 * Tiny Mustache-style template renderer for prompt-optimizer templates.
 *
 * Supports only the two patterns used by the ported templates:
 *   - `{{varName}}`                        → JSON.stringify-safe substitution
 *   - `{{{varName}}}`                      → raw substitution
 *   - `{{#helpers.toJson}}{{{varName}}}{{/helpers.toJson}}` → JSON-stringify the value
 *
 * Missing/undefined values render as empty string.
 *
 * The implementation does a **single left-to-right pass** with one combined
 * regex. This is important for the prompt-injection guard: substituted user
 * values must not be re-scanned for template syntax, otherwise a malicious
 * input like `"Original {{secret}}"` would leak the value of `secret` from
 * the variables map.
 */

export type OptimizerVariables = Record<string, string | undefined | null>;

const COMBINED_PATTERN = /\{\{#helpers\.toJson\}\}\s*\{\{\{(\w+)\}\}\}\s*\{\{\/helpers\.toJson\}\}|\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g;

export const render = (template: string, variables: OptimizerVariables): string =>
    template.replaceAll(COMBINED_PATTERN, (_match, toJsonKey?: string, tripleKey?: string, doubleKey?: string) => {
        const key = toJsonKey ?? tripleKey ?? doubleKey;

        if (!key) {
            return "";
        }

        const value = variables[key] ?? "";

        if (toJsonKey) {
            return JSON.stringify(value);
        }

        return value;
    });
