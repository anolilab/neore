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
}

/** `acpView` from the core: names only, never a variable's value. */
export interface AcpView {
    agents: { args: string[]; command: string; envNames: string[]; key: string; label: string }[];
    envNames: string[];
}

export type AcpUpdate
    = | { args: string[]; command: string; key: string; label: string; op: "saveAgent" }
        | { key: string; op: "removeAgent" }
        | { agentKey?: string; name: string; op: "setEnv"; value: string }
        | { agentKey?: string; name: string; op: "removeEnv" };

export type StopReason = "cancelled" | "end_turn" | "failed" | "max_tokens" | "max_turn_requests" | "refusal";

/** `cancelled` is ours: ACP has no such tool status, so a cancel ends every open call as this. */
export type ToolStatus = "cancelled" | "completed" | "failed" | "in_progress" | "pending";

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
