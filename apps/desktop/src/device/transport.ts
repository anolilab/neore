/**
 * The seam between the device IPC handlers and whatever runs the device calls. Every call the main
 * process makes goes through a `HostTransport`; `index.ts` never touches the addon directly.
 *
 * `local` is the only implementation: the napi addon in this process (`device-core-node`). Structured
 * values cross the addon as JSON strings and are parsed here, so a transport hands back typed values.
 */
import { loadDeviceCore } from "./addon";
import type { CoreEvent, DeviceStatus, Prompt, SettingsView, Signed } from "./types";

export interface HostTransport {
    auditTail: () => string[];
    /** Closing the approval window is a "no" to everything it was asking. */
    denyPrompts: () => void;
    /** Verifies, asks about, runs and signs one relayed call. */
    execute: (envelope: string, signature: string) => Promise<Signed>;
    readonly kind: "local";
    manifest: () => Promise<Signed>;
    pair: (deviceId: string, secret: string, accountLabel: string) => Promise<boolean>;
    promptAnswer: (id: number, answer: string) => void;
    promptCurrent: () => Prompt | null;
    reapIdleServers: () => Promise<boolean>;
    settingsGet: () => SettingsView;
    settingsUpdate: (update: string) => SettingsView;
    status: () => DeviceStatus;
    stop: () => void;
}

/** Loads the addon and wraps it. Throws when the addon cannot load; the caller keeps the shell running. */
export const createLocalTransport = (dataDirectory: string, onEvent: (event: CoreEvent) => void): HostTransport => {
    const DeviceCore = loadDeviceCore();
    const core = new DeviceCore(dataDirectory, (json) => onEvent(JSON.parse(json) as CoreEvent));

    return {
        auditTail: () => core.auditTail(),
        denyPrompts: () => core.denyPrompts(),
        execute: async (envelope, signature) => JSON.parse(await core.execute(envelope, signature)) as Signed,
        kind: "local",
        manifest: async () => JSON.parse(await core.manifest()) as Signed,
        pair: (deviceId, secret, accountLabel) => core.pair(deviceId, secret, accountLabel),
        promptAnswer: (id, answer) => core.promptAnswer(id, answer),
        promptCurrent: () => {
            const json = core.promptCurrent();

            return json === null ? null : (JSON.parse(json) as Prompt);
        },
        reapIdleServers: () => core.reapIdleServers(),
        settingsGet: () => JSON.parse(core.settingsGet()) as SettingsView,
        settingsUpdate: (update) => JSON.parse(core.settingsUpdate(update)) as SettingsView,
        status: () => JSON.parse(core.status()) as DeviceStatus,
        stop: () => core.stop(),
    };
};
