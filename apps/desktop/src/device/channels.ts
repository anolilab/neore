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
    acpCancel: "neore:device-local:acp-cancel",
    acpClose: "neore:device-local:acp-close",
    acpForget: "neore:device-local:acp-forget",
    acpPermissionAnswer: "neore:device-local:acp-permission-answer",
    acpPermissionAnswerBatch: "neore:device-local:acp-permission-answer-batch",
    acpPermissionDecline: "neore:device-local:acp-permission-decline",
    acpPermissions: "neore:device-local:acp-permissions",
    acpProbe: "neore:device-local:acp-probe",
    acpRegistryInstall: "neore:device-local:acp-registry-install",
    acpRegistrySearch: "neore:device-local:acp-registry-search",
    acpSend: "neore:device-local:acp-send",
    acpSession: "neore:device-local:acp-session",
    acpSessions: "neore:device-local:acp-sessions",
    acpStart: "neore:device-local:acp-start",
    acpUpdate: "neore:device-local:acp-update",
    acpView: "neore:device-local:acp-view",
    auditTail: "neore:device-local:audit-tail",
    confirm: "neore:device-local:confirm",
    hostConnect: "neore:device-local:host-connect",
    hostDisconnect: "neore:device-local:host-disconnect",
    hostForgetKey: "neore:device-local:host-forget-key",
    hostRemove: "neore:device-local:host-remove",
    hostUpgrade: "neore:device-local:host-upgrade",
    openHostTerminal: "neore:device-local:open-host-terminal",
    openTerminal: "neore:device-local:open-terminal",
    pickFolder: "neore:device-local:pick-folder",
    promptAnswer: "neore:device-local:prompt-answer",
    promptCurrent: "neore:device-local:prompt-current",
    promptSecret: "neore:device-local:prompt-secret",
    settingsGet: "neore:device-local:settings-get",
    settingsUpdate: "neore:device-local:settings-update",
    terminalAvailability: "neore:device-local:terminal-availability",
    terminalSshAvailability: "neore:device-local:terminal-ssh-availability",
} as const;

/** Main → device window: a prompt was queued, read `promptCurrent` again. */
export const LOCAL_EVENT = {
    /** A coding-agent session changed: read the sessions again. */
    acp: "neore:device-local:acp",
    prompt: "neore:device-local:prompt",
} as const;
