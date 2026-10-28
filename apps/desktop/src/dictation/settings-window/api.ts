import type { Language } from "../settings";
import type { SettingsView } from "../settings-api";

/** What the settings window's preload gives its page (`window.neoreDictationSettings`). */
export interface DictationSettingsWindowApi {
    download: (id: string) => Promise<SettingsView>;
    get: () => Promise<SettingsView>;
    /** A download or deletion ended; the handler gets a sentence for the status line. Returns the unsubscribe function. */
    onChanged: (handler: (message: string | undefined) => void) => () => void;
    remove: (id: string) => Promise<SettingsView>;
    update: (update: { enabled?: boolean; language?: Language; model?: string }) => Promise<SettingsView>;
}
