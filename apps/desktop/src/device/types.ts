/**
 * The wire shapes `device-core-node` returns. Structured values cross the addon
 * as JSON strings; these are their parsed forms (`device-core/src/engine.rs`).
 */

/** A payload and its HMAC, exactly as the device or the backend signed it. */
export interface Signed {
    payload: string;
    signature: string;
}

/** A server this computer speaks for, and whether it is connected right now (`HostStatus` in `engine/hosts.rs`). */
export interface HostStatus {
    connected: boolean;
    deviceId: string;
    name: string;
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
    name: string;
    platform: string | null;
    port: number;
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
        | { type: "acpPermissionsChanged" }
        | { type: "changed" };

/** The surface of the native `DeviceCore` class. */
export interface DeviceCore {
    /** Coding agents (ACP): JSON strings, parsed by `acp/`. The spawn plan holds secrets and never leaves the main process. */
    acpPermissionAnswer: (id: number, optionId: string) => void;
    acpPermissionAnswerBatch: (ids: number[]) => number;
    acpPermissionAnswerRemote: (sessionId: string, requestId: string, optionId: string) => void;
    acpPermissionAsk: (request: string) => Promise<string>;
    acpPermissionCancelSession: (sessionId: string) => void;
    acpPermissionDecline: (id: number) => void;
    acpPermissions: () => string;
    /** A relayed coding-agent command, checked but not acted on (`acp/commands.ts`). */
    acpPrepare: (envelope: string, signature: string) => string;
    acpSign: (envelope: string, signature: string, outcome: string) => string;
    acpSpawnPlan: (agentKey: string, folder: string | null) => string;
    acpUpdate: (update: string) => string;
    acpView: () => string;
    auditTail: () => string[];
    denyPrompts: () => void;
    execute: (envelope: string, signature: string) => Promise<string>;
    hostConnect: (deviceId: string) => Promise<string>;
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
    status: () => string;
    stop: () => void;
}

export type DeviceCoreConstructor = new (dataDirectory: string, onEvent: (json: string) => void, hostBundle?: string) => DeviceCore;
