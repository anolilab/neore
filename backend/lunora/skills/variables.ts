/**
 * `{{variable}}` placeholders in skill instructions. Pure, so the executor (a
 * real invocation) and the builder (a test drive of an unsaved draft) share one
 * reading of the syntax and one `[MISSING:x]` marker.
 */
import { VARIABLE_REGEX } from "./constants";

/** The placeholder names in `content`, in order of first appearance. */
export const extractVariables = (content: string): string[] => {
    const names = new Set<string>();

    for (const match of content.matchAll(VARIABLE_REGEX)) {
        // The regex has one capture group, but a group is `string | undefined` to
        // the type system — a non-participating group is legal in general.
        if (match[1] !== undefined) {
            names.add(match[1]);
        }
    }

    return [...names];
};

/**
 * Replace every placeholder with `resolve(name)`; one it cannot resolve becomes a
 * visible `[MISSING:name]`, so a gap shows up in the output instead of silently
 * reading as literal braces.
 */
export const substituteVariables = (content: string, resolve: (name: string) => string | undefined): string =>
    content.replaceAll(VARIABLE_REGEX, (_match, name: string) => resolve(name) ?? `[MISSING:${name}]`);
