/**
 * The wire shapes `device-core-node` returns. Structured values cross the addon
 * as JSON strings; these are their parsed forms (`device-core/src/engine.rs`).
 */

/** A payload and its HMAC, exactly as the device or the backend signed it. */
export interface Signed {
    payload: string;
    signature: string;
}

/** Who this computer is paired as (`StatusView` in `device-core/src/engine.rs`). */
export interface DeviceStatus {
    accountLabel: string | null;
    deviceId: string | null;
    platform: string;
}

export interface Prompt {
    body:
        | { accountLabel: string; kind: "pairing" }
        | {
            allowAlways: boolean;
            detail: string;
            input: string;
            kind: "call";
            sandbox: { confined: boolean; note: string } | null;
            taintedBy: string[];
            threadTitle: string;
            tool: string;
            toolKind: string;
        };
    expiresAt: number;
    id: number;
}

export interface SettingsView {
    accountLabel: string | null;
    allowRules: string[];
    allowShellNetwork: boolean;
    auditPath: string;
    mcpServers: { args: string[]; command: string; env: Record<string, string>; name: string }[];
    paired: boolean;
    requireShellSandbox: boolean;
    roots: string[];
    sandboxUnavailable: string | null;
}

/** What the engine emits, parsed from the addon's JSON event strings. */
export type CoreEvent = { agent: string; tool: string; type: "acpPermission" } | { sessionId: string; turnId: string; type: "acpCancel" } | { prompt: Prompt; type: "prompt" } | { callId: string; payload: string; signature: string; type: "progress" } | { type: "changed" };

/** The surface of the native `DeviceCore` class. */
export interface DeviceCore {
    /** Coding agents (ACP): JSON strings, parsed by `acp/`. The spawn plan holds secrets and never leaves the main process. */
    acpPermissionAnswer: (id: number, optionId: string) => void;
    acpPermissionAnswerBatch: (ids: number[]) => number;
    acpPermissionAsk: (request: string) => Promise<string>;
    acpPermissionCancelSession: (sessionId: string) => void;
    acpPermissionDecline: (id: number) => void;
    acpPermissions: () => string;
    acpSpawnPlan: (agentKey: string, folder: string | null) => string;
    acpUpdate: (update: string) => string;
    acpView: () => string;
    auditTail: () => string[];
    denyPrompts: () => void;
    execute: (envelope: string, signature: string) => Promise<string>;
    manifest: () => Promise<string>;
    pair: (deviceId: string, secret: string, accountLabel: string) => Promise<boolean>;
    promptAnswer: (id: number, answer: string) => void;
    promptCurrent: () => string | null;
    reapIdleServers: () => Promise<boolean>;
    settingsGet: () => string;
    settingsUpdate: (update: string) => string;
    /** Signs one turn post for the backend's ingest route; refuses anything that is not a turn post for this computer. */
    signTurn: (payload: string) => string;
    status: () => string;
    stop: () => void;
}

export type DeviceCoreConstructor = new (dataDirectory: string, onEvent: (json: string) => void) => DeviceCore;
