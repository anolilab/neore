/** What the local device window's preload exposes as `window.neoreDevice`. */
import type { Prompt, SettingsView } from "../types";

export interface DeviceWindowApi {
    auditTail: () => Promise<string[]>;
    confirm: (message: string) => Promise<boolean>;
    onPromptQueued: (handler: () => void) => () => void;
    pickFolder: () => Promise<string | null>;
    promptAnswer: (id: number, answer: "always" | "deny" | "once") => Promise<void>;
    promptCurrent: () => Promise<Prompt | null>;
    settingsGet: () => Promise<SettingsView>;
    settingsUpdate: (update: Record<string, unknown>) => Promise<SettingsView>;
}

declare global {
    // The preload exposes this on the page's global object; the device page reads it from there.
    var neoreDevice: DeviceWindowApi;
}
