/** What the local device window's preload exposes as `window.neoreDevice`. */
import type { HostProbe, Prompt, SettingsView } from "../types";

declare global {
    // The preload exposes this on the page's global object; the device page reads it from there.
    // eslint-disable-next-line vars-on-top -- declare global takes var, not let or const
    var neoreDevice: DeviceWindowApi;
}

export interface DeviceWindowApi {
    auditTail: () => Promise<string[]>;
    confirm: (message: string) => Promise<boolean>;
    hostConnect: (deviceId: string) => Promise<HostProbe>;
    hostDisconnect: (deviceId: string) => Promise<void>;
    hostForgetKey: (deviceId: string) => Promise<void>;
    hostRemove: (deviceId: string) => Promise<void>;
    onPromptQueued: (handler: () => void) => () => void;
    pickFolder: () => Promise<string | null>;
    promptAnswer: (id: number, answer: "always" | "deny" | "once") => Promise<void>;
    promptCurrent: () => Promise<Prompt | null>;
    /** The text typed for a passphrase prompt. */
    promptSecret: (id: number, secret: string) => Promise<void>;
    settingsGet: () => Promise<SettingsView>;
    settingsUpdate: (update: Record<string, unknown>) => Promise<SettingsView>;
}
