/** The most first-run setup steps a user can have skipped. */
export const MAX_SKIPPED_SETUP_STEPS = 8;

/** The one way a stored skipped list is capped: the newest {@link MAX_SKIPPED_SETUP_STEPS} entries stay, the oldest go first. */
export const capSkippedSteps = (steps: ReadonlyArray<string>): string[] => steps.slice(-MAX_SKIPPED_SETUP_STEPS);

/**
 * The skipped steps of two lists as one, oldest first: the `older` list's entries come first, the `newer` list's that are
 * not already there follow, and the cap drops from the front, so the `newer` list's choices are the ones kept.
 */
export const mergeSkippedSteps = (older: ReadonlyArray<string> | undefined, newer: ReadonlyArray<string> | undefined): string[] => {
    const newerSteps = newer ?? [];
    const merged = (older ?? []).filter((id) => !newerSteps.includes(id));

    return capSkippedSteps([...merged, ...newerSteps]);
};
