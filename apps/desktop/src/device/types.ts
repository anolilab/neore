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

/** One entry of a folder on a server. What it says is the server's word: show it as text, never as markup. */
export interface FileEntry {
    name: string;
    size: number;
    type: "dir" | "file" | "other" | "symlink" | "unknown";
}

/** One page of a folder on a connected server (`host_files_list`). */
export interface FilesPage {
    entries: FileEntry[];
    /** The server the page came from. */
    host: string;
    /** Pass as `after` for the page that follows; `null` on the last. */
    next: string | null;
    path: string;
    /** The folder had more entries than the server reads at all. */
    truncated: boolean;
}

/** A file of a server as text (`host_file_read`). */
export interface FileRead {
    host: string;
    path: string;
    text: string;
    truncated: boolean;
}

/** What a downloaded folder holds (`archive::Summary`). Symlinks and special files are not in the archive. */
export interface Download {
    bytes: number;
    files: number;
    folders: number;
    host: string;
    /** Links and special files, left out on purpose. */
    skipped: number;
    /** Files and folders that should be in the archive and are not: unreadable, or too deep. */
    unreadable: number;
}

/** A server as the local window lists it (`HostView`). */
export interface HostView {
    /** The coding agents registered for this server (their commands are paths on it) and the folders each is approved for. */
    acpAgents: { args: string[]; command: string; envNames: string[]; install: null; key: string; label: string }[];
    acpConsents: { agentKey: string; folderId: string; folderLabel: string; folderPath: string }[];
    address: string;
    /** Whether the host software on the server runs coding agents; null while not connected. */
    agentsSupported: boolean | null;
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

/** How far a sandboxed program may reach into the network (`NetworkTier` in `sandbox.rs`). */
export type NetworkTier = "dependencies" | "off" | "on";

/** A local MCP server as stored (`McpServerConfig` in `mcp.rs`). */
export interface McpServer {
    args: string[];
    command: string;
    env: Record<string, string>;
    name: string;
    network: NetworkTier;
}

/** Whether a configured server will run sandboxed here (`McpServerStatus` in `engine.rs`). */
export interface McpServerStatus {
    name: string;
    /** Why its network tier is not fully enforced although it is sandboxed (Off, on a computer that cannot block sockets); `null` when it is. */
    networkGap: string | null;
    /** What its approval prompt says about the sandbox and the network tier; empty when it cannot start. */
    note: string;
    /** Why it cannot start; `null` when it can. */
    problem: string | null;
    sandboxed: boolean;
}

export interface SettingsView {
    accountLabel: string | null;
    allowRules: string[];
    /** `shellNetwork === "on"`; kept for the Rust view's older readers. */
    allowShellNetwork: boolean;
    auditPath: string;
    /** Why "Common dependencies only" cannot be enforced on this computer; `null` when it can. */
    dependenciesUnavailable: string | null;
    hosts: HostView[];
    mcpServers: McpServer[];
    /** One per entry of `mcpServers`, in order. */
    mcpStatus: McpServerStatus[];
    paired: boolean;
    requireShellSandbox: boolean;
    roots: string[];
    sandboxUnavailable: string | null;
    shellNetwork: NetworkTier;
}

/** What the engine emits, parsed from the addon's JSON event strings. */
export type CoreEvent
    = | { agent: string; tool: string; type: "acpPermission" }
        | { callId: string; deviceId: string; payload: string; signature: string; type: "progress" }
        | { prompt: Prompt; type: "prompt" }
        | { type: "acpPermissionsChanged" }
        | { code: number | null; error: string | null; handle: number; signal: number | null; type: "hostAgentEnded" }
        | { data: string; handle: number; stream: "stderr" | "stdout"; type: "hostAgent" }
        | { type: "changed" };

/** The surface of the native `DeviceCore` class. */
export interface DeviceCore {
    /** What to start for an approved agent on a server (JSON): only the user's variables, the server builds the rest. */
    acpHostSpawnPlan: (deviceId: string, agentKey: string, folder: string) => string;
    acpInstall: (request: string) => string;
    acpInstallPrune: (agentKey: string) => void;
    acpInstallStage: () => string;
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
    /** Reads a file an agent's reply refers to, in Rust: only inside the folder the agent was approved for, only an allowed type. */
    acpReadMedia: (agentKey: string, folder: string, reference: string) => Promise<MediaRead>;
    acpSign: (envelope: string, signature: string, outcome: string) => string;
    acpSpawnPlan: (agentKey: string, folder: string | null) => string;
    acpUpdate: (update: string) => string;
    acpView: () => string;
    auditTail: () => string[];
    denyPrompts: () => void;
    execute: (envelope: string, signature: string) => Promise<string>;
    hostAcpUpdate: (deviceId: string, update: string) => string;
    hostAgentStart: (deviceId: string, handle: number, agentKey: string, folder: string) => string;
    hostAgentStop: (handle: number) => void;
    hostAgentWrite: (handle: number, bytes: Buffer) => void;
    hostConnect: (deviceId: string, retry: boolean) => Promise<string>;
    hostDisconnect: (deviceId: string) => void;
    hostDownload: (deviceId: string, path: string, destination: string) => Promise<string>;
    hostFileRead: (deviceId: string, path: string) => Promise<string>;
    hostFilesList: (deviceId: string, path: string, after?: string) => Promise<string>;
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
