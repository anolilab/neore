/**
 * The seam between the device IPC handlers and whatever runs the device calls. Every call the main
 * process makes goes through a `HostTransport`; `index.ts` never touches the addon directly.
 *
 * `local` is the only implementation: the napi addon in this process (`device-core-node`). Structured
 * values cross the addon as JSON strings and are parsed here, so a transport hands back typed values.
 */
import { loadDeviceCore } from "./addon";
import type { CoreEvent, DeviceCore as DeviceCoreHandle, DeviceStatus, HostProbe, HostSpec, Prompt, SettingsView, Signed } from "./types";

export interface HostTransport {
    auditTail: () => string[];
    /** Closing the approval window is a "no" to everything it was asking. */
    denyPrompts: () => void;
    /** Verifies, asks about, runs and signs one relayed call. */
    execute: (envelope: string, signature: string) => Promise<Signed>;
    /** Connects a paired server again. */
    hostConnect: (deviceId: string) => Promise<HostProbe>;
    hostDisconnect: (deviceId: string) => void;
    /** Drops the pinned host key, so the next connection asks to trust whatever the server presents. */
    hostForgetKey: (deviceId: string) => void;
    /** Stores a probed server as a device of its own, after a local confirmation. */
    hostPair: (spec: HostSpec, deviceId: string, secret: string) => Promise<boolean>;
    /** Connects a server that is not paired yet, asking to trust its key and for a key passphrase. */
    hostProbe: (spec: HostSpec) => Promise<HostProbe>;
    hostRemove: (deviceId: string) => void;
    readonly kind: "local";
    /** This computer's signed tool list, or a server's (signed with that server's own secret). */
    manifest: (deviceId?: string) => Promise<Signed>;
    pair: (deviceId: string, secret: string, accountLabel: string) => Promise<boolean>;
    promptAnswer: (id: number, answer: string) => void;
    promptCurrent: () => Prompt | null;
    /** The text typed for a passphrase prompt. Goes to ssh and nowhere else. */
    promptSecret: (id: number, secret: string) => void;
    reapIdleServers: () => Promise<boolean>;
    settingsGet: () => SettingsView;
    settingsUpdate: (update: string) => SettingsView;
    status: () => DeviceStatus;
    stop: () => void;
}

/** Loads the addon and wraps it. Throws when the addon cannot load; the caller keeps the shell running. */
export const createLocalTransport = (dataDirectory: string, onEvent: (event: CoreEvent) => void): HostTransport & { core: DeviceCoreHandle } => {
    const DeviceCore = loadDeviceCore();
    const core = new DeviceCore(dataDirectory, (json) => onEvent(JSON.parse(json) as CoreEvent));

    return {
        auditTail: () => core.auditTail(),
        // The coding-agent handlers address this computer's core directly; they are not part of the seam.
        core,
        denyPrompts: () => core.denyPrompts(),
        execute: async (envelope, signature) => JSON.parse(await core.execute(envelope, signature)) as Signed,
        hostConnect: async (deviceId) => JSON.parse(await core.hostConnect(deviceId)) as HostProbe,
        hostDisconnect: (deviceId) => core.hostDisconnect(deviceId),
        hostForgetKey: (deviceId) => core.hostForgetKey(deviceId),
        hostPair: (spec, deviceId, secret) => core.hostPair(JSON.stringify(spec), deviceId, secret),
        hostProbe: async (spec) => JSON.parse(await core.hostProbe(JSON.stringify(spec))) as HostProbe,
        hostRemove: (deviceId) => core.hostRemove(deviceId),
        kind: "local",
        manifest: async (deviceId) => JSON.parse(await core.manifest(deviceId)) as Signed,
        pair: (deviceId, secret, accountLabel) => core.pair(deviceId, secret, accountLabel),
        promptAnswer: (id, answer) => core.promptAnswer(id, answer),
        promptCurrent: () => {
            const json = core.promptCurrent();

            return json === null ? null : (JSON.parse(json) as Prompt);
        },
        promptSecret: (id, secret) => core.promptSecret(id, secret),
        reapIdleServers: () => core.reapIdleServers(),
        settingsGet: () => JSON.parse(core.settingsGet()) as SettingsView,
        settingsUpdate: (update) => JSON.parse(core.settingsUpdate(update)) as SettingsView,
        status: () => JSON.parse(core.status()) as DeviceStatus,
        stop: () => core.stop(),
    };
};
