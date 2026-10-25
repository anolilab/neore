/**
 * The reasoning-effort stops the `ReasoningEffortSelector` slider offers (0 to 100 in steps of 25),
 * and the stepping the composer's effort shortcuts do over them.
 */
export const EFFORT_MIN = 0;
export const EFFORT_MAX = 100;
export const EFFORT_STEP = 25;
/** What the selector shows for a chat that has no effort set. */
export const EFFORT_DEFAULT = 50;

export const EFFORT_STOPS: ReadonlyArray<number> = Array.from(
    { length: (EFFORT_MAX - EFFORT_MIN) / EFFORT_STEP + 1 },
    (_, index) => EFFORT_MIN + index * EFFORT_STEP,
);

export type EffortDirection = "decrease" | "increase";

/**
 * The next stop in `direction`, clamped at both ends (no wrap). A value between two stops moves to
 * the nearer stop on the requested side; no value starts from {@link EFFORT_DEFAULT}.
 */
export const stepReasoningEffort = (current: number | undefined, direction: EffortDirection): number => {
    const value = current ?? EFFORT_DEFAULT;

    if (direction === "increase") {
        return EFFORT_STOPS.find((stop) => stop > value) ?? EFFORT_MAX;
    }

    return EFFORT_STOPS.findLast((stop) => stop < value) ?? EFFORT_MIN;
};

/** The model catalog entry's capability test; the selector's own (`reasoning-effort-selector.tsx`). */
export const supportsReasoningEffort = (
    models: ReadonlyArray<{ filterCapabilities?: ReadonlyArray<string>; id: string }>,
    modelId: string | undefined,
): boolean => models.find((candidate) => candidate.id === modelId)?.filterCapabilities?.includes("reasoning") ?? false;
