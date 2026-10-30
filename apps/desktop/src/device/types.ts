/**
 * The wire shapes `device-core-node` returns. Structured values cross the addon
 * as JSON strings; these are their parsed forms (`device-core/src/engine.rs`).
 */

import type { MediaRead } from "../acp/media";

/** A payload and its HMAC, exactly as the device or the backend signed it. */
export interface Signed {
    payload: string;
    signature: string;
}

/**
 * Where the connection of a server the person connected stands when it is not simply up (`ReconnectView` in
 * `engine/reconnect.rs`): waiting for the next attempt, trying, or out of attempts and waiting for a Retry.
 */
export interface ReconnectView {
    /** The attempt in the window, once one is scheduled or running. */
    attempt: number | null;
    maxAttempts: number;
    /** When the next attempt starts, in milliseconds since the epoch. */
    nextAttemptAt: number | null;
    phase: "connecting" | "gaveUp" | "waiting";
    /** Why it gave up. */
    reason: string | null;
}

/** A server this computer speaks for, and whether it is connected right now (`HostStatus` in `engine/hosts.rs`). */
export interface HostStatus {
    connected: boolean;
    deviceId: string;
    name: string;
    /** Absent while the connection is simply up or was never connected. */
    reconnect?: ReconnectView;
}

/** Who this computer is paired as (`StatusView` in `device-core/src/engine.rs`). */
export interface DeviceStatus {
    accountLabel: string | null;
    deviceId: string | null;
    hosts: HostStatus[];
    platform: string;
}

/** Where a server is and how to log in (`HostSpec` in `engine/hosts.rs`). The page supplies it. */
export interface HostSpec {
    address: string;
    identityFile?: string;
    name: string;
    port?: number;
    user: string;
}

/** What a connected server reported about itself (`HostProbe`). */
export interface HostProbe {
    platform: string;
    sandboxAvailable: boolean;
    sandboxDetail: string;
    version: string;
}

/** What installing or upgrading a server's host software did (`HostUpgrade`). */
export interface HostUpgrade {
    /** The server already had this exact binary: nothing was uploaded. */
    alreadyCurrent: boolean;
    version: string;
}

/** A server as the local window lists it (`HostView`). */
export interface HostView {
    address: string;
    allowShellNetwork: boolean;
    connected: boolean;
    deviceId: string;
    forwardAgent: boolean;
    identityFile: string | null;
    /** False where Neore does not share one connection between sessions (Windows): the server has an ssh process of its own. */
    multiplexed: boolean;
    name: string;
    platform: string | null;
    port: number;
    reconnect: ReconnectView | null;
    requireShellSandbox: boolean;
    roots: string[];
    sandboxDetail: string | null;
    user: string;
}

export interface Prompt {
    body:
        | { accountLabel: string; kind: "pairing" }
        | { address: string; identityFile: string | null; installVersion: string | null; kind: "hostConnect"; name: string; port: number; user: string }
        | { address: string; identityFile: string | null; kind: "hostPairing"; name: string; port: number; user: string }
        | { fingerprint: string; host: string; identityFile: string | null; keyType: string; kind: "hostKey"; port: number }
        | { host: string; kind: "hostKeyChanged"; pinned: string[]; port: number; presented: string[] }
        | { host: string; kind: "passphrase"; prompt: string }
        | {
            allowAlways: boolean;
            detail: string;
            /** The server the call runs on; absent for this computer. */
            host?: string;
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
    hosts: HostView[];
    mcpServers: { args: string[]; command: string; env: Record<string, string>; name: string }[];
    paired: boolean;
    requireShellSandbox: boolean;
    roots: string[];
    sandboxUnavailable: string | null;
}

/** What the engine emits, parsed from the addon's JSON event strings. */
export type CoreEvent
    = | { agent: string; tool: string; type: "acpPermission" }
        | { callId: string; deviceId: string; payload: string; signature: string; type: "progress" }
        | { prompt: Prompt; type: "prompt" }
        | { sessionId: string; turnId: string; type: "acpCancel" }
        | { type: "changed" };

/** The surface of the native `DeviceCore` class. */
export interface DeviceCore {
    /** Coding agents (ACP): JSON strings, parsed by `acp/`. The spawn plan holds secrets and never leaves the main process. */
    acpPermissionAnswer: (id: number, optionId: string) => void;
    acpPermissionAnswerBatch: (ids: number[]) => number;
    acpPermissionAsk: (request: string) => Promise<string>;
    acpPermissionCancelSession: (sessionId: string) => void;
    acpPermissionDecline: (id: number) => void;
    acpPermissions: () => string;
    /** Reads a file an agent's reply refers to, in Rust: only inside the folder the agent was approved for, only an allowed type. */
    acpReadMedia: (agentKey: string, folder: string, reference: string) => Promise<MediaRead>;
    acpSpawnPlan: (agentKey: string, folder: string | null) => string;
    acpUpdate: (update: string) => string;
    acpView: () => string;
    auditTail: () => string[];
    denyPrompts: () => void;
    execute: (envelope: string, signature: string) => Promise<string>;
    hostConnect: (deviceId: string, retry: boolean) => Promise<string>;
    hostDisconnect: (deviceId: string) => void;
    hostForgetKey: (deviceId: string) => void;
    hostPair: (spec: string, deviceId: string, secret: string) => Promise<boolean>;
    hostProbe: (spec: string) => Promise<string>;
    hostRemove: (deviceId: string) => void;
    hostTerminal: (deviceId: string) => Promise<string>;
    hostTerminalAttach: (deviceId: string) => Promise<string>;
    hostUpgrade: (deviceId: string) => Promise<string>;
    manifest: (deviceId?: string) => Promise<string>;
    pair: (deviceId: string, secret: string, accountLabel: string) => Promise<boolean>;
    promptAnswer: (id: number, answer: string) => void;
    promptCurrent: () => string | null;
    promptSecret: (id: number, secret: string) => void;
    reapIdleServers: () => Promise<boolean>;
    settingsGet: () => string;
    settingsUpdate: (update: string) => string;
    /** Signs one turn post for the backend's ingest route; refuses anything that is not a turn post for this computer. */
    signTurn: (payload: string) => string;
    /** Signs one request to the backend's device upload route; refuses anything that is not an upload request for this computer. */
    signUpload: (payload: string) => string;
    status: () => string;
    stop: () => void;
}

export type DeviceCoreConstructor = new (dataDirectory: string, onEvent: (json: string) => void, hostBundle?: string) => DeviceCore;
