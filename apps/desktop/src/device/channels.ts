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
    manifest: "neore:device:manifest",
    openSettings: "neore:device:open-settings",
    pair: "neore:device:pair",
    progress: "neore:device:progress",
    status: "neore:device:status",
} as const;

export const LOCAL_CHANNEL = {
    acpCancel: "neore:device-local:acp-cancel",
    acpClose: "neore:device-local:acp-close",
    acpForget: "neore:device-local:acp-forget",
    acpProbe: "neore:device-local:acp-probe",
    acpSend: "neore:device-local:acp-send",
    acpSession: "neore:device-local:acp-session",
    acpSessions: "neore:device-local:acp-sessions",
    acpStart: "neore:device-local:acp-start",
    acpUpdate: "neore:device-local:acp-update",
    acpView: "neore:device-local:acp-view",
    auditTail: "neore:device-local:audit-tail",
    confirm: "neore:device-local:confirm",
    pickFolder: "neore:device-local:pick-folder",
    promptAnswer: "neore:device-local:prompt-answer",
    promptCurrent: "neore:device-local:prompt-current",
    settingsGet: "neore:device-local:settings-get",
    settingsUpdate: "neore:device-local:settings-update",
} as const;

/** Main → device window: a prompt was queued, read `promptCurrent` again. */
export const LOCAL_EVENT = {
    /** A coding-agent session changed: read the sessions again. */
    acp: "neore:device-local:acp",
    prompt: "neore:device-local:prompt",
} as const;
