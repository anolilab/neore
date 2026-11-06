/**
 * The most first-run setup steps a user can have skipped. One number for the settings column's validator
 * (`auth/fields.ts`), the skip mutation (`auth/setup-steps.ts`) and the web checklist's optimistic list.
 */
export const MAX_SKIPPED_SETUP_STEPS = 8;

/**
 * The skipped steps of two lists as one: the first list's entries stay, the second's that are not already there
 * follow, and the newest {@link MAX_SKIPPED_SETUP_STEPS} are kept.
 */
export const mergeSkippedSteps = (kept: ReadonlyArray<string> | undefined, added: ReadonlyArray<string> | undefined): string[] => {
    const merged = [...(kept ?? [])];

    const extra = added ?? [];

    for (const id of extra) {
        if (!merged.includes(id)) {
            merged.push(id);
        }
    }

    return merged.slice(-MAX_SKIPPED_SETUP_STEPS);
};
