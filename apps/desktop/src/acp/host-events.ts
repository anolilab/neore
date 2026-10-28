/** What an agent session reports about its turns, and what the backend is told of them (`ingest.ts`). */
import type { StopReason } from "./types";

export interface PermissionOption {
    kind: string;
    name: string;
    optionId: string;
}

export interface PermissionRequestEvent {
    command?: string;
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
    sessionOpened: (sessionId: string, info: HostSessionInfo) => void;
    text: (sessionId: string, turnId: string, delta: string) => void;
    thought: (sessionId: string, turnId: string, delta: string) => void;
    tool: (sessionId: string, turnId: string, tool: { id: string; kind: string; status: string; title: string }) => void;
    turnEnded: (sessionId: string, turnId: string, reason: StopReason | "failed", error?: string) => void;
    turnStarted: (sessionId: string, turnId: string, user: string) => void;
}

/** How a stop reason is told to the backend. */
export const endReasonOf = (reason: StopReason | "failed"): "cancelled" | "failed" | "finished" => {
    if (reason === "cancelled") {
        return "cancelled";
    }

    return reason === "failed" ? "failed" : "finished";
};

/** What one post came to: the backend's next `seq`, a request to resend from there, a refusal, or a reason to try again. */
export type PostResult = { kind: "gap"; next: number } | { ended: boolean; kind: "ok"; next: number; threadId?: string } | { kind: "refused" } | { kind: "retry" };

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** Exponential from one second to thirty, with jitter (half to full), so hosts that failed together do not retry together. */
export const jitteredBackoff = (attempts: number, random: () => number): number =>
    Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.min(attempts, 10)) * (0.5 + random() * 0.5);
