/** What the local device window's preload exposes as `window.neoreDevice`. */
import type { CapabilityReport } from "@neore/ai/capabilities";

import type { RegistryListing } from "../../acp/registry";
import type { AcpUpdate, AcpView, ImportSummary, NativeSessionView, PermissionView, ProbeResult, SessionSnapshot, SessionSummary } from "../../acp/types";
import type { Availability } from "../../terminal/shell";
import type { Prompt, SettingsView } from "../types";

declare global {
    // The preload exposes this on the page's global object; the device page reads it from there.
    // eslint-disable-next-line vars-on-top -- declare global takes var, not let or const
    var neoreDevice: DeviceWindowApi;
}

export interface DeviceWindowApi {
    acpCancel: (sessionId: string) => Promise<void>;
    acpClose: (sessionId: string) => Promise<void>;
    acpForget: (sessionId: string) => Promise<void>;
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
    onAcpChanged: (handler: () => void) => () => void;
    onPromptQueued: (handler: () => void) => () => void;
    /** Opens a terminal for the folder; `null` asks for one. */
    openTerminal: (folder: string | null) => Promise<void>;
    pickFolder: () => Promise<string | null>;
    promptAnswer: (id: number, answer: "always" | "deny" | "once") => Promise<void>;
    promptCurrent: () => Promise<Prompt | null>;
    settingsGet: () => Promise<SettingsView>;
    settingsUpdate: (update: Record<string, unknown>) => Promise<SettingsView>;
    terminalAvailability: () => Promise<Availability>;
}
