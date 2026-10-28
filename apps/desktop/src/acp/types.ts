/**
 * Shapes shared by the ACP process manager (main process) and the local device window.
 * Everything in a transcript came from an agent: the window renders it with `textContent` only.
 */

/** What the Rust core returns for `acpSpawnPlan`; the environment holds secrets and stays in the main process. */
export interface SpawnPlan {
    args: string[];
    command: string;
    cwd: string;
    env: Record<string, string>;
    /** `cwd` is a folder the core made for a version probe: removed once the probe is over. */
    scratch: boolean;
    /** Names of the variables the user set: the only values scrubbed from what the window shows. */
    secretNames: string[];
}

/** `acpView` from the core: names only, never a variable's value. */
/** An approval the user gave in this window: one agent in one folder. */
export interface AcpConsent {
    agentKey: string;
    folderId: string;
    folderLabel: string;
    folderPath: string;
}

/** A permission request waiting for the user: the core's `acpPermissions`, parsed. */
export interface PermissionView {
    agentLabel: string;
    /** Allow-once is offered and the details are complete: it may be approved together with others. */
    batchable: boolean;
    command: string | null;
    details: string;
    detailsComplete: boolean;
    folder: string;
    id: number;
    /** The agent's own allow-once options; no "always" option is ever listed. */
    options: { kind: string; name: string; optionId: string }[];
    sessionId: string;
    target: string | null;
    tool: string;
    toolKind: string;
}

export interface AcpView {
    agents: { args: string[]; command: string; envNames: string[]; key: string; label: string }[];
    consents: AcpConsent[];
    envNames: string[];
}

export type AcpUpdate
    = | { args: string[]; command: string; key: string; label: string; op: "saveAgent" }
        | { key: string; op: "removeAgent" }
        | { agentKey: string; folder: string; op: "grant" }
        | { agentKey: string; folderId: string; op: "revoke" }
        | { agentKey?: string; name: string; op: "setEnv"; value: string }
        | { agentKey?: string; name: string; op: "removeEnv" };

export type StopReason = "cancelled" | "end_turn" | "failed" | "max_tokens" | "max_turn_requests" | "refusal";

/** `cancelled` and `declined` are ours: ACP has neither, so a cancel ends every open call as the first, a "no" the second. */
export type ToolStatus = "cancelled" | "completed" | "declined" | "failed" | "in_progress" | "pending";

export interface ToolState {
    id: string;
    kind: string;
    status: ToolStatus;
    title: string;
}

export interface TurnState {
    id: string;
    /** Set once the turn ended; unset while it runs. */
    stopReason?: StopReason;
    /** The agent's reply. Cut at `MAX_TURN_TEXT` characters; `truncated` says so. */
    text: string;
    thought: string;
    tools: ToolState[];
    truncated: boolean;
    user: string;
}

export type SessionStatus = "busy" | "ended" | "idle" | "starting";

export interface SessionSnapshot {
    agentKey: string;
    agentLabel: string;
    /** Why the session ended, when it ended on its own. */
    endReason?: string;
    folder: string;
    id: string;
    queued: string[];
    status: SessionStatus;
    turns: TurnState[];
}

/** What the session list shows; the transcript is read per session. */
export type SessionSummary = Pick<SessionSnapshot, "agentKey" | "agentLabel" | "endReason" | "folder" | "id" | "status"> & { queued: number };

export interface ProbeResult {
    agentName: string;
    agentVersion: string;
    protocolVersion: number;
}

/** What the agent can do, as it reported it. Kept raw: the capability mapping reads it later. */
export type AgentCapabilities = Record<string, unknown>;
