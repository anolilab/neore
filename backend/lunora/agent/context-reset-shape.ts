/**
 * The divider a scheduled task's run leaves in a thread it keeps reusing with a fresh model context
 * (`tasks/AGENTS.md`). Like an agent switch it is one `system` row with no text, so no model is ever
 * shown it (`docsToModelMessages` drops empty rows), and the transcript renders it as a divider.
 * No runtime import, so the browser can read the part's shape.
 */

/** The `providerMetadata` key that marks a row as a context reset. */
export const CONTEXT_RESET_KEY = "neoreContextReset";

export interface ContextResetPart {
    /** Why the context was reset; only a task run writes one today. */
    reason: "task_run";
}

/** The part a row carries when it is a context reset, else `undefined`. */
export const contextResetOf = (row: { providerMetadata?: unknown }): ContextResetPart | undefined => {
    const stored = (row.providerMetadata as Record<string, unknown> | undefined)?.[CONTEXT_RESET_KEY];

    if (typeof stored !== "object" || stored === null) {
        return undefined;
    }

    return (stored as { reason?: unknown }).reason === "task_run" ? { reason: "task_run" } : undefined;
};
