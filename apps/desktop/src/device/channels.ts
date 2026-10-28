/**
 * IPC channel names for device execution. Shared by `index.ts` (the main
 * process), the site preload (relay channels) and the local window's preload.
 *
 * The site may invoke only `DEVICE_CHANNEL` and receive `DEVICE_CHANNEL.progress`
 * and `.changed`. `LOCAL_CHANNEL` and `LOCAL_EVENT` belong to the device window
 * alone; `index.ts` refuses them from any other sender.
 */

export const DEVICE_CHANNEL = {
    changed: "neore:device:changed",
    execute: "neore:device:execute",
    hostConnect: "neore:device:host-connect",
    hostDisconnect: "neore:device:host-disconnect",
    hostPair: "neore:device:host-pair",
    hostProbe: "neore:device:host-probe",
    manifest: "neore:device:manifest",
    openSettings: "neore:device:open-settings",
    pair: "neore:device:pair",
    progress: "neore:device:progress",
    status: "neore:device:status",
} as const;

export const LOCAL_CHANNEL = {
    auditTail: "neore:device-local:audit-tail",
    confirm: "neore:device-local:confirm",
    hostConnect: "neore:device-local:host-connect",
    hostDisconnect: "neore:device-local:host-disconnect",
    hostForgetKey: "neore:device-local:host-forget-key",
    hostRemove: "neore:device-local:host-remove",
    pickFolder: "neore:device-local:pick-folder",
    promptAnswer: "neore:device-local:prompt-answer",
    promptCurrent: "neore:device-local:prompt-current",
    promptSecret: "neore:device-local:prompt-secret",
    settingsGet: "neore:device-local:settings-get",
    settingsUpdate: "neore:device-local:settings-update",
} as const;

/** Main → device window: a prompt was queued, read `promptCurrent` again. */
export const LOCAL_EVENT = {
    prompt: "neore:device-local:prompt",
} as const;
