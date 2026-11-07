import { CONTEXT_CLEAR_CONFLICT } from "@neore/backend/agent/context-reset-shape";

/** Whether a sent text is the `/clear` command rather than a message for the model. */
export const isClearCommand = (text: string): boolean => text.trim().toLowerCase() === "/clear";

/**
 * Whether a `/clear` that just finished removes the command from the composer: only the composer it was sent from, still
 * shown, on the same chat, with the draft still the bare command. A chat the person moved to keeps its own draft.
 */
export const clearsDraftAfterReset = (state: {
    currentThreadId: string | undefined;
    draft: string;
    mounted: boolean;
    startedThreadId: string | undefined;
}): boolean => state.mounted && state.currentThreadId === state.startedThreadId && isClearCommand(state.draft);

/**
 * Why the server refused a `/clear` (`chat/context-reset.ts`, `acp/switch.ts`): a conflict's own `data.code` first, else the
 * error's code; `failed` for anything else. `already_made` is this click's clear, made by an earlier delivery.
 */
export type ClearRefusal = "agent_starting" | "already_made" | "busy" | "failed" | "not_owner" | "rate_limited" | "unavailable";

export const clearRefusalOf = (error: unknown): ClearRefusal => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };

    switch (data?.code) {
        case CONTEXT_CLEAR_CONFLICT.agentStarting: {
            return "agent_starting";
        }
        case CONTEXT_CLEAR_CONFLICT.alreadyMade: {
            return "already_made";
        }
        case CONTEXT_CLEAR_CONFLICT.replyRunning: {
            return "busy";
        }
        default: {
            break;
        }
    }

    switch (data?.code ?? code) {
        case "BAD_REQUEST": {
            return "unavailable";
        }
        case "CONFLICT": {
            return "busy";
        }
        case "FORBIDDEN": {
            return "not_owner";
        }
        case "TOO_MANY_REQUESTS": {
            return "rate_limited";
        }
        default: {
            return "failed";
        }
    }
};
