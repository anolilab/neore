/**
 * Who answers an agent's `session/request_permission`.
 *
 * The answer is always one of the agent's own option ids or `cancelled`: the host never invents an id. Nothing
 * here can answer with an "always" option; the real gate (the Rust core) refuses those from any source.
 */

export interface PermissionRequest {
    agentLabel: string;
    /** The session's folder, as the user approved it. */
    folder: string;
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

/** What the core needs to show a request and to answer it. */
export interface DescribedRequest {
    agentLabel: string;
    command?: string;
    details: string;
    detailsComplete: boolean;
    folder: string;
    options: { kind: string; name: string; optionId: string }[];
    sessionId: string;
    target?: string;
    tool: string;
    toolKind: string;
}

/** The longest details sent to the core; it cuts them further, and anything cut is not "complete". */
const MAX_DETAILS_SENT = 64 * 1024;

const stringOf = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;

const commandOf = (rawInput: unknown): string | undefined => {
    if (!isRecord(rawInput)) {
        return undefined;
    }

    const command = rawInput.command ?? rawInput.cmd;

    if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
        return command.join(" ");
    }

    return stringOf(command);
};

const targetOf = (toolCall: Record<string, unknown>): string | undefined => {
    const [first] = Array.isArray(toolCall.locations) ? toolCall.locations : [];

    if (isRecord(first) && typeof first.path === "string") {
        return typeof first.line === "number" ? `${first.path}:${String(first.line)}` : first.path;
    }

    const { rawInput } = toolCall;

    return isRecord(rawInput) ? stringOf(rawInput.file_path) ?? stringOf(rawInput.filePath) ?? stringOf(rawInput.path) ?? stringOf(rawInput.url) : undefined;
};

/**
 * What the user is shown for a request: the tool, its target and command, and every detail the agent sent.
 * A request that carried nothing beyond a title has no details to read, and is never approved in a batch.
 */
export const describePermission = (request: PermissionRequest): DescribedRequest => {
    const toolCall = isRecord(request.params.toolCall) ? request.params.toolCall : {};
    const { content, rawInput } = toolCall;
    const hasContent = Array.isArray(content) && content.length > 0;
    const full = JSON.stringify({ content, kind: toolCall.kind, locations: toolCall.locations, rawInput, title: toolCall.title }, undefined, 2);

    return {
        agentLabel: request.agentLabel,
        command: commandOf(rawInput),
        details: full.slice(0, MAX_DETAILS_SENT),
        detailsComplete: (rawInput !== undefined || hasContent) && full.length <= MAX_DETAILS_SENT,
        folder: request.folder,
        options: offeredOptions(request.params),
        sessionId: request.sessionId,
        target: targetOf(toolCall),
        tool: stringOf(toolCall.title) ?? "A tool call",
        toolKind: stringOf(toolCall.kind) ?? "other",
    };
};

/** The core, as far as the gate needs it. */
export interface PermissionCore {
    acpPermissionAsk: (request: string) => Promise<string>;
    acpPermissionCancelSession: (sessionId: string) => void;
}

/**
 * Asks the person in the device window, through the core. The core decides what an answer may be (an option the
 * agent offered, once, never "always"); this only carries it, and cancels on anything unexpected.
 */
export const coreGate = (core: PermissionCore): PermissionGate => {
    return {
        ask: async (request) => {
            try {
                const described = describePermission(request);
                const outcome: unknown = JSON.parse(await core.acpPermissionAsk(JSON.stringify(described)));

                if (isRecord(outcome) && outcome.outcome === "selected" && described.options.some((option) => option.optionId === outcome.optionId)) {
                    return { optionId: outcome.optionId as string, outcome: "selected" };
                }
            } catch {
                // Falls through: an agent is never left waiting on a request nobody can answer.
            }

            return { outcome: "cancelled" };
        },
        cancelSession: (sessionId) => core.acpPermissionCancelSession(sessionId),
    };
};

/** Declines every request with the agent's own reject-once option (or cancels when it offers none). */
export const declineGate: PermissionGate = {
    ask: async (request) => {
        const reject = offeredOptions(request.params).find((option) => option.kind === "reject_once");

        return reject === undefined ? { outcome: "cancelled" } : { optionId: reject.optionId, outcome: "selected" };
    },
    cancelSession: () => {},
};
