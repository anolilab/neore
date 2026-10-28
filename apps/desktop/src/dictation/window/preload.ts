/**
 * Preload of the dictation window only (the site's preload never sees it). It carries audio out to the main process
 * and nothing else: no network, no file access, no way to read anything back. Sandboxed: its only import is `electron`
 * (`scripts/build.mjs` checks that).
 */
import { contextBridge, ipcRenderer } from "electron";

import { DICTATION_CHANNEL, DICTATION_EVENT } from "../channels";
import type { DictationWindowApi } from "./api";

const api: DictationWindowApi = {
    audio: (chunk) => ipcRenderer.send(DICTATION_CHANNEL.audio, chunk),
    ended: () => ipcRenderer.send(DICTATION_CHANNEL.ended),
    failed: (failure) => ipcRenderer.send(DICTATION_CHANNEL.failed, failure),
    onStop: (handler) => {
        ipcRenderer.once(DICTATION_EVENT.stop, () => handler());
    },
};

contextBridge.exposeInMainWorld("neoreDictation", api);
