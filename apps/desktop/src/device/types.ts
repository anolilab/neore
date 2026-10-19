/**
 * The wire shapes `device-core-node` returns. Structured values cross the addon
 * as JSON strings; these are their parsed forms (`device-core/src/engine.rs`).
 */

/** A payload and its HMAC, exactly as the device or the backend signed it. */
export interface Signed {
    payload: string;
    signature: string;
}

export interface DeviceStatus {
    accountLabel: string | null;
    deviceId: string | null;
    platform: "linux" | "macos" | "windows";
}

export interface Prompt {
    body:
        | { accountLabel: string; kind: "pairing" }
        | {
            allowAlways: boolean;
            detail: string;
            input: string;
            kind: "call";
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
    auditPath: string;
    mcpServers: { args: string[]; command: string; env: Record<string, string>; name: string }[];
    paired: boolean;
    requireShellSandbox: boolean;
    roots: string[];
    sandboxUnavailable: string | null;
}

/** What the engine emits, parsed from the addon's JSON event strings. */
export type CoreEvent
    = | { prompt: Prompt; type: "prompt" }
        | { callId: string; payload: string; signature: string; type: "progress" }
        | { type: "changed" };

/** The surface of the native `DeviceCore` class. */
export interface DeviceCore {
    auditTail: () => string[];
    denyPrompts: () => void;
    execute: (envelope: string, signature: string) => Promise<string>;
    manifest: () => Promise<string>;
    pair: (deviceId: string, secret: string, accountLabel: string) => Promise<boolean>;
    promptAnswer: (id: number, answer: string) => void;
    promptCurrent: () => string | null;
    reapIdleServers: () => void;
    settingsGet: () => string;
    settingsUpdate: (update: string) => string;
    status: () => string;
    stop: () => void;
}

export type DeviceCoreConstructor = new (dataDir: string, onEvent: (json: string) => void) => DeviceCore;
