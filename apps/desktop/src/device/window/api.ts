/** What the local device window's preload exposes as `window.neoreDevice`. */
import type { Availability } from "../../terminal/shell";
import type { Prompt, SettingsView } from "../types";

declare global {
    // The preload exposes this on the page's global object; the device page reads it from there.
    // eslint-disable-next-line vars-on-top -- declare global takes var, not let or const
    var neoreDevice: DeviceWindowApi;
}

export interface DeviceWindowApi {
    auditTail: () => Promise<string[]>;
    confirm: (message: string) => Promise<boolean>;
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
