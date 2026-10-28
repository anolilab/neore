/** What the local device window's preload exposes as `window.neoreDevice`. */
import type { AcpUpdate, AcpView, PermissionView, ProbeResult, SessionSnapshot, SessionSummary } from "../../acp/types";
import type { Availability } from "../../terminal/shell";
import type { Download, FileRead, FilesPage, HostProbe, HostUpgrade, Prompt, SettingsView } from "../types";

declare global {
    // The preload exposes this on the page's global object; the device page reads it from there.
    // eslint-disable-next-line vars-on-top -- declare global takes var, not let or const
    var neoreDevice: DeviceWindowApi;
}

export interface DeviceWindowApi {
    acpCancel: (sessionId: string) => Promise<void>;
    acpClose: (sessionId: string) => Promise<void>;
    acpForget: (sessionId: string) => Promise<void>;
    acpPermissionAnswer: (id: number, optionId: string) => Promise<void>;
    acpPermissionAnswerBatch: (ids: number[]) => Promise<number>;
    acpPermissionDecline: (id: number) => Promise<void>;
    acpPermissions: () => Promise<PermissionView[]>;
    acpProbe: (agentKey: string) => Promise<ProbeResult>;
    acpSend: (sessionId: string, prompt: string) => Promise<{ position?: number; status: "queued" | "started" }>;
    acpSession: (sessionId: string) => Promise<SessionSnapshot>;
    acpSessions: () => Promise<SessionSummary[]>;
    acpStart: (agentKey: string, folder: string) => Promise<string>;
    acpUpdate: (update: AcpUpdate) => Promise<AcpView>;
    acpView: () => Promise<AcpView>;
    auditTail: () => Promise<string[]>;
    confirm: (message: string) => Promise<boolean>;
    hostConnect: (deviceId: string) => Promise<HostProbe>;
    hostDisconnect: (deviceId: string) => Promise<void>;
    /** Asks for a file to save to, then downloads the server folder into it as a tar. `null` when cancelled. */
    hostDownload: (deviceId: string, path: string) => Promise<Download | null>;
    hostFileRead: (deviceId: string, path: string) => Promise<FileRead>;
    hostFilesList: (deviceId: string, path: string, after?: string) => Promise<FilesPage>;
    hostForgetKey: (deviceId: string) => Promise<void>;
    hostRemove: (deviceId: string) => Promise<void>;
    hostUpgrade: (deviceId: string) => Promise<HostUpgrade>;
    onAcpChanged: (handler: () => void) => () => void;
    onChanged: (handler: () => void) => () => void;
    onPromptQueued: (handler: () => void) => () => void;
    /** Opens a terminal on a paired server, connecting it first (which asks to trust its key). */
    openHostTerminal: (deviceId: string) => Promise<void>;
    /** Opens a terminal for the folder; `null` asks for one. */
    openTerminal: (folder: string | null) => Promise<void>;
    pickFolder: () => Promise<string | null>;
    promptAnswer: (id: number, answer: "always" | "deny" | "once") => Promise<void>;
    promptCurrent: () => Promise<Prompt | null>;
    /** The text typed for a passphrase prompt. */
    promptSecret: (id: number, secret: string) => Promise<void>;
    settingsGet: () => Promise<SettingsView>;
    settingsUpdate: (update: Record<string, unknown>) => Promise<SettingsView>;
    terminalAvailability: () => Promise<Availability>;
    /** Whether a terminal on a server is offered (not on Windows yet). */
    terminalSshAvailability: () => Promise<Availability>;
}
