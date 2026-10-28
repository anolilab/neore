/** What an agent session reports about its turns, and what the backend is told of them (`ingest.ts`). */
import type { StopReason } from "./types";

export interface PermissionOption {
    kind: string;
    name: string;
    optionId: string;
}

export interface PermissionRequestEvent {
    command?: string;
    /** False when anything the person decides on is missing: the details were cut, here or by the core. A remote "allow" is never offered for it. */
    complete?: boolean;
    folder?: string;
    kind: "permission_request";
    options: PermissionOption[];
    requestId: string;
    target?: string;
    tool: string;
}

export type PermissionOutcomeKind = "allowed" | "cancelled" | "declined";

export type HostEvent
    = PermissionRequestEvent | { agentKey: string; agentLabel: string; folderId: string; folderLabel: string; kind: "session_open" } | { error?: string; kind: "turn_end"; reason: "cancelled" | "failed" | "finished" | "interrupted" } | { id: string; kind: "tool"; status: string; title: string; toolKind: string } | { kind: "permission_resolved"; outcome: PermissionOutcomeKind; requestId: string } | { kind: "reasoning" | "text" | "turn_start"; text: string };

export interface HostSessionInfo {
    agentKey: string;
    agentLabel: string;
    folderId: string;
    folderLabel: string;
}

/** What an `AgentSession` tells whoever persists its turns. Every method returns at once and never throws. */
export interface SessionObserver {
    permissionRequested: (sessionId: string, turnId: string, request: PermissionRequestEvent) => void;
    permissionResolved: (sessionId: string, turnId: string, requestId: string, outcome: PermissionOutcomeKind) => void;
    sessionEnded: (sessionId: string) => void;
    /** `threadId` is known when the backend started the session (`acp_start`); otherwise opening it makes the thread. */
    sessionOpened: (sessionId: string, info: HostSessionInfo, threadId?: string) => void;
    text: (sessionId: string, turnId: string, delta: string) => void;
    thought: (sessionId: string, turnId: string, delta: string) => void;
    tool: (sessionId: string, turnId: string, tool: { id: string; kind: string; status: string; title: string }) => void;
    turnEnded: (sessionId: string, turnId: string, reason: StopReason | "failed", error?: string) => void;
    /** A prompt the backend queued (`acp_send`) is in this computer's hands, running or waiting its turn: the turn is `received`. */
    turnReceived?: (sessionId: string, turnId: string, user: string) => void;
    turnStarted: (sessionId: string, turnId: string, user: string) => void;
}

// The backend's limits on what one event may carry (`backend/lunora/acp/validators.ts`). A post with one field past
// them is refused whole, so the host cuts to them first.
const MAX_PROMPT_CHARS = 100_000;
const MAX_OPTIONS = 16;
const MAX_COMMAND_CHARS = 10_000;
const MAX_TARGET_CHARS = 2000;

/** A session's labels, cut to what the backend takes. */
export const capSessionInfo = (info: HostSessionInfo): HostSessionInfo => {
    return {
        agentKey: info.agentKey.slice(0, 128),
        agentLabel: info.agentLabel.slice(0, 200),
        folderId: info.folderId.slice(0, 128),
        folderLabel: info.folderLabel.slice(0, 200),
    };
};

/** A permission request, cut to what the backend takes. `command` and `target` may carry paths; the user chose to show them (plan §4.4). */
export const capPermissionRequest = (request: PermissionRequestEvent): PermissionRequestEvent => {
    const cut = (request.command?.length ?? 0) > MAX_COMMAND_CHARS || (request.target?.length ?? 0) > MAX_TARGET_CHARS;

    return {
        complete: request.complete !== false && !cut,
        kind: "permission_request",
        options: request.options.slice(0, MAX_OPTIONS).map((option) => {
            return { kind: option.kind.slice(0, 64), name: option.name.slice(0, 200), optionId: option.optionId.slice(0, 128) };
        }),
        requestId: capRequestId(request.requestId),
        tool: request.tool.slice(0, 500),
        ...request.folder !== undefined && { folder: request.folder.slice(0, 500) },
        ...request.command !== undefined && { command: request.command.slice(0, MAX_COMMAND_CHARS) },
        ...request.target !== undefined && { target: request.target.slice(0, MAX_TARGET_CHARS) },
    };
};

export const capRequestId = (requestId: string): string => requestId.slice(0, 128);

/**
 * What an event adds to the body of a post, in UTF-8 bytes: the payload is JSON inside a JSON string, so quotes
 * and backslashes are escaped twice, and a CJK character is three bytes. The backend caps the body, not the characters.
 */
export const wireBytes = (event: HostEvent): number => Buffer.byteLength(JSON.stringify(JSON.stringify(event)));

/** The largest single event a batch may start with; a batch's first event is always taken, so it must fit alone. */
const MAX_EVENT_BYTES = 150_000;

/** The user's prompt as the first event of a turn: within the backend's character cap and, for any script, within one post. */
export const capPrompt = (text: string): string => {
    let cut = text.slice(0, MAX_PROMPT_CHARS);

    while (wireBytes({ kind: "turn_start", text: cut }) > MAX_EVENT_BYTES) {
        cut = cut.slice(0, Math.floor(cut.length * 0.8));
    }

    return cut;
};

const LIMIT_STOPS: ReadonlySet<StopReason | "failed"> = new Set(["failed", "max_tokens", "max_turn_requests"]);

/** How a stop reason is told to the backend. */
export const endReasonOf = (reason: StopReason | "failed"): "cancelled" | "failed" | "finished" => {
    if (reason === "cancelled") {
        return "cancelled";
    }

    // An agent that stopped at a limit did not finish the turn: it is told as a failure until a usage-limit outcome exists.
    return LIMIT_STOPS.has(reason) ? "failed" : "finished";
};

/** What one post came to: the backend's next `seq`, a request to resend from there, a refusal, or a reason to try again. */
export type PostResult = { kind: "gap"; next: number } | { ended: boolean; kind: "ok"; next: number; threadId?: string } | { kind: "refused" } | { kind: "retry" };

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** Exponential from one second to thirty, with jitter (half to full), so hosts that failed together do not retry together. */
export const jitteredBackoff = (attempts: number, random: () => number): number =>
    Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.min(attempts, 10)) * (0.5 + random() * 0.5);
