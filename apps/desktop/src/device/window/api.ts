/** What the local device window's preload exposes as `window.neoreDevice`. */
import type { CapabilityReport } from "@neore/ai/capabilities";

import type { HooksView } from "../../acp/hooks/types";
import type { RegistryListing } from "../../acp/registry";
import type { AcpUpdate, AcpView, ImportSummary, NativeSessionView, PermissionView, ProbeResult, SessionSnapshot, SessionSummary } from "../../acp/types";
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
    /** Runs a manual hook of the approved `.neore/hooks.json`: its prompt goes to this open session. `hash` is the file the person was shown. */
    acpHookRun: (sessionId: string, hookId: string, hash: string) => Promise<void>;
    /** The folder's hooks file with every hook in full, and whether this exact file is approved. */
    acpHooks: (sessionId: string) => Promise<HooksView>;
    /** Approves the hooks file with this hash; refused if the file on disk has changed since it was shown. */
    acpHooksApprove: (sessionId: string, hash: string) => Promise<void>;
    acpHooksRevoke: (sessionId: string) => Promise<void>;
    /** Imports one of the agent's saved sessions as a thread. The agent and the folder must have been approved here. */
    acpImport: (agentKey: string, folder: string, nativeSessionId: string, title?: string) => Promise<ImportSummary>;
    /** The agent's saved sessions for the folder. Refused unless the agent advertised listing them. */
    acpImportList: (agentKey: string, folder: string) => Promise<NativeSessionView[]>;
    acpPermissionAnswer: (id: number, optionId: string) => Promise<void>;
    acpPermissionAnswerBatch: (ids: number[]) => Promise<number>;
    acpPermissionDecline: (id: number) => Promise<void>;
    acpPermissions: () => Promise<PermissionView[]>;
    acpProbe: (agentKey: string) => Promise<ProbeResult>;
    /** Asks the main process to install a listed agent. It words and shows the confirmation itself; `null` is a "no". */
    acpRegistryInstall: (id: string, version: string) => Promise<AcpView | null>;
    acpRegistrySearch: (query: string) => Promise<RegistryListing[]>;
    /** What each agent reported at its last start, by agent key. An agent not started since this app began has none. */
    acpReports: () => Promise<Record<string, CapabilityReport>>;
    acpSend: (sessionId: string, prompt: string) => Promise<{ position?: number; status: "queued" | "started" }>;
    acpSession: (sessionId: string) => Promise<SessionSnapshot>;
    acpSessions: () => Promise<SessionSummary[]>;
    acpStart: (agentKey: string, folder: string) => Promise<string>;
    acpUpdate: (update: AcpUpdate) => Promise<AcpView>;
    acpView: () => Promise<AcpView>;
    auditTail: () => Promise<string[]>;
    confirm: (message: string) => Promise<boolean>;
    hostAcpUpdate: (deviceId: string, update: AcpUpdate) => Promise<Pick<AcpView, "agents" | "consents">>;
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
