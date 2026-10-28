/**
 * Preload of the LOCAL dictation settings window only (the site's preload never sees it). It exposes the four settings
 * commands and nothing else. Sandboxed: its only import is `electron` (`scripts/build.mjs` checks that).
 */
import { contextBridge, ipcRenderer } from "electron";

import { SETTINGS_CHANNEL, SETTINGS_EVENT } from "../settings-channels";
import type { DictationSettingsWindowApi } from "./api";

const api: DictationSettingsWindowApi = {
    download: (id) => ipcRenderer.invoke(SETTINGS_CHANNEL.download, id),
    get: () => ipcRenderer.invoke(SETTINGS_CHANNEL.get),
    onChanged: (handler) => {
        const listener = (_event: unknown, message?: string) => handler(message);

        ipcRenderer.on(SETTINGS_EVENT.changed, listener);

        return () => ipcRenderer.removeListener(SETTINGS_EVENT.changed, listener);
    },
    remove: (id) => ipcRenderer.invoke(SETTINGS_CHANNEL.remove, id),
    update: (update) => ipcRenderer.invoke(SETTINGS_CHANNEL.update, update),
};

contextBridge.exposeInMainWorld("neoreDictationSettings", api);
