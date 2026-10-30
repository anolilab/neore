/**
 * IPC names for the dictation settings window. Shared by the main process and that window's own preload.
 * The site never sees these: `settings-window.ts` accepts them from the settings window's page alone.
 */
export const SETTINGS_CHANNEL = {
    /** Page → main: start downloading a model. The argument is a model id. */
    download: "neore:dictation-settings:download",
    /** Page → main: what to show. */
    get: "neore:dictation-settings:get",
    /** Page → main: delete a model's file. The argument is a model id. */
    remove: "neore:dictation-settings:remove",
    /** Page → main: change the switch, the model or the language. */
    update: "neore:dictation-settings:update",
} as const;

/** Main → page. */
export const SETTINGS_EVENT = {
    /** A download or a deletion finished; the argument is a sentence for the status line, or nothing. */
    changed: "neore:dictation-settings:changed",
} as const;
