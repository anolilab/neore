/**
 * Preload of the LOCAL device window only (the site's preload never sees it).
 * It exposes the approval and settings commands and nothing else. Sandboxed:
 * only `electron` and the built-ins can be required, so `scripts/build.mjs`
 * bundles this to one CJS file.
 */
import { contextBridge, ipcRenderer } from "electron";

import { LOCAL_CHANNEL, LOCAL_EVENT } from "../channels";
import type { DeviceWindowApi } from "./api";

const api: DeviceWindowApi = {
    auditTail: () => ipcRenderer.invoke(LOCAL_CHANNEL.auditTail),
    confirm: (message) => ipcRenderer.invoke(LOCAL_CHANNEL.confirm, message),
    hostConnect: (deviceId) => ipcRenderer.invoke(LOCAL_CHANNEL.hostConnect, deviceId),
    hostDisconnect: (deviceId) => ipcRenderer.invoke(LOCAL_CHANNEL.hostDisconnect, deviceId),
    hostForgetKey: (deviceId) => ipcRenderer.invoke(LOCAL_CHANNEL.hostForgetKey, deviceId),
    hostRemove: (deviceId) => ipcRenderer.invoke(LOCAL_CHANNEL.hostRemove, deviceId),
    onPromptQueued: (handler) => {
        const listener = () => handler();

        ipcRenderer.on(LOCAL_EVENT.prompt, listener);

        return () => ipcRenderer.removeListener(LOCAL_EVENT.prompt, listener);
    },
    openTerminal: (folder) => ipcRenderer.invoke(LOCAL_CHANNEL.openTerminal, folder),
    pickFolder: () => ipcRenderer.invoke(LOCAL_CHANNEL.pickFolder),
    promptAnswer: (id, answer) => ipcRenderer.invoke(LOCAL_CHANNEL.promptAnswer, id, answer),
    promptCurrent: () => ipcRenderer.invoke(LOCAL_CHANNEL.promptCurrent),
    promptSecret: (id, secret) => ipcRenderer.invoke(LOCAL_CHANNEL.promptSecret, id, secret),
    settingsGet: () => ipcRenderer.invoke(LOCAL_CHANNEL.settingsGet),
    settingsUpdate: (update) => ipcRenderer.invoke(LOCAL_CHANNEL.settingsUpdate, update),
    terminalAvailability: () => ipcRenderer.invoke(LOCAL_CHANNEL.terminalAvailability),
};

contextBridge.exposeInMainWorld("neoreDevice", api);
