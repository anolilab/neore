/**
 * The "New context" divider, read without the validators or the database so the browser can read it too. It is one
 * `system` row with no text, so no model is ever shown it (`docsToModelMessages` drops empty rows), and the transcript
 * renders it as a divider. Two writers leave one, told apart by `reason`:
 *
 * - `task_run`: a scheduled task's run, in a thread it keeps reusing with a fresh model context (`tasks/AGENTS.md`,
 *   `appendContextReset`). It marks where a run began; the run itself reads no history (`freshContext`), and the
 *   thread's other replies still read across it.
 * - `clear`: `/clear` (`chat/context-reset.ts`). Everything before it on its path is left out of what a reply is sent
 *   (`isContextResetRow`, `agent/context-reset.ts`).
 */

/** The `providerMetadata` key that marks a row as a context reset. */
export const CONTEXT_RESET_KEY = "neoreContextReset";

export interface ContextResetPart {
    /** Who left the divider: a task run, or `/clear`. */
    reason: "clear" | "task_run";
}

/** The part a row carries when it is a context reset, else `undefined`. */
export const contextResetOf = (row: { providerMetadata?: unknown }): ContextResetPart | undefined => {
    const stored = (row.providerMetadata as Record<string, unknown> | null | undefined)?.[CONTEXT_RESET_KEY];

    if (typeof stored !== "object" || stored === null) {
        return undefined;
    }

    const { reason } = stored as { reason?: unknown };

    return reason === "task_run" || reason === "clear" ? { reason } : undefined;
};

/**
 * Whether `row` is a `/clear` divider, the one kind that cuts what a reply is sent. The canonical row is an empty system
 * row; a model's own message carrying the marker is not one.
 */
export const isContextResetRow = (row: { message?: unknown; providerMetadata?: unknown }): boolean => {
    const message = row.message as { content?: unknown; role?: unknown } | null | undefined;

    return contextResetOf(row)?.reason === "clear" && message?.role === "system" && message.content === "";
};

/** The message and metadata a `/clear` divider is stored with. */
export const contextResetRowContent = (): { message: { content: string; role: "system" }; providerMetadata: Record<string, ContextResetPart> } => {
    return {
        message: { content: "", role: "system" },
        providerMetadata: { [CONTEXT_RESET_KEY]: { reason: "clear" } },
    };
};

/** Why a `/clear` was refused as a conflict, in the error's `data.code`, so the app can say which one. */
export const CONTEXT_CLEAR_CONFLICT = {
    /** A coding agent's session is still opening, or its turn has not reported back. */
    agentStarting: "CONTEXT_CLEAR_AGENT_STARTING",
    /** This click's clear was made already (a repeated delivery). */
    alreadyMade: "CONTEXT_CLEAR_ALREADY_MADE",
    /** A reply is running. */
    replyRunning: "CONTEXT_CLEAR_REPLY_RUNNING",
} as const;
