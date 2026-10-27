/**
 * Who answers an agent's `session/request_permission`.
 *
 * The answer is always one of the agent's own option ids or `cancelled`: the host never invents an id. Nothing
 * here can answer with an "always" option; the real gate (the Rust core) refuses those from any source.
 */

export interface PermissionRequest {
    /** The request as the agent sent it: `sessionId`, `toolCall`, `options`. */
    params: Record<string, unknown>;
    /** Our session id, not the agent's. */
    sessionId: string;
}

export type PermissionOutcome = { optionId: string; outcome: "selected" } | { outcome: "cancelled" };

export interface PermissionGate {
    ask: (request: PermissionRequest) => Promise<PermissionOutcome>;
    /** Answers every request still waiting for this session as cancelled. */
    cancelSession: (sessionId: string) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The agent's offered options that have a string id and a kind, in the order it listed them. */
export const offeredOptions = (params: Record<string, unknown>): { kind: string; name: string; optionId: string }[] => {
    if (!Array.isArray(params.options)) {
        return [];
    }

    return params.options.flatMap((option: unknown) => {
        if (!isRecord(option) || typeof option.optionId !== "string" || typeof option.kind !== "string") {
            return [];
        }

        return [{ kind: option.kind, name: typeof option.name === "string" ? option.name : option.optionId, optionId: option.optionId }];
    });
};

/** Declines every request with the agent's own reject-once option (or cancels when it offers none). */
export const declineGate: PermissionGate = {
    ask: async (request) => {
        const reject = offeredOptions(request.params).find((option) => option.kind === "reject_once");

        return reject === undefined ? { outcome: "cancelled" } : { optionId: reject.optionId, outcome: "selected" };
    },
    cancelSession: () => {},
};
