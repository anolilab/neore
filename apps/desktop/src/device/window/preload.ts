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
    acpCancel: (sessionId) => ipcRenderer.invoke(LOCAL_CHANNEL.acpCancel, sessionId),
    acpClose: (sessionId) => ipcRenderer.invoke(LOCAL_CHANNEL.acpClose, sessionId),
    acpForget: (sessionId) => ipcRenderer.invoke(LOCAL_CHANNEL.acpForget, sessionId),
    acpImport: (agentKey, folder, nativeSessionId, title) => ipcRenderer.invoke(LOCAL_CHANNEL.acpImport, agentKey, folder, nativeSessionId, title),
    acpImportList: (agentKey, folder) => ipcRenderer.invoke(LOCAL_CHANNEL.acpImportList, agentKey, folder),
    acpPermissionAnswer: (id, optionId) => ipcRenderer.invoke(LOCAL_CHANNEL.acpPermissionAnswer, id, optionId),
    acpPermissionAnswerBatch: (ids) => ipcRenderer.invoke(LOCAL_CHANNEL.acpPermissionAnswerBatch, ids),
    acpPermissionDecline: (id) => ipcRenderer.invoke(LOCAL_CHANNEL.acpPermissionDecline, id),
    acpPermissions: () => ipcRenderer.invoke(LOCAL_CHANNEL.acpPermissions),
    acpProbe: (agentKey) => ipcRenderer.invoke(LOCAL_CHANNEL.acpProbe, agentKey),
    acpRegistryInstall: (id, version) => ipcRenderer.invoke(LOCAL_CHANNEL.acpRegistryInstall, id, version),
    acpRegistrySearch: (query) => ipcRenderer.invoke(LOCAL_CHANNEL.acpRegistrySearch, query),
    acpReports: () => ipcRenderer.invoke(LOCAL_CHANNEL.acpReports),
    acpSend: (sessionId, prompt) => ipcRenderer.invoke(LOCAL_CHANNEL.acpSend, sessionId, prompt),
    acpSession: (sessionId) => ipcRenderer.invoke(LOCAL_CHANNEL.acpSession, sessionId),
    acpSessions: () => ipcRenderer.invoke(LOCAL_CHANNEL.acpSessions),
    acpStart: (agentKey, folder) => ipcRenderer.invoke(LOCAL_CHANNEL.acpStart, agentKey, folder),
    acpUpdate: (update) => ipcRenderer.invoke(LOCAL_CHANNEL.acpUpdate, update),
    acpView: () => ipcRenderer.invoke(LOCAL_CHANNEL.acpView),
    auditTail: () => ipcRenderer.invoke(LOCAL_CHANNEL.auditTail),
    confirm: (message) => ipcRenderer.invoke(LOCAL_CHANNEL.confirm, message),
    hostConnect: (deviceId) => ipcRenderer.invoke(LOCAL_CHANNEL.hostConnect, deviceId),
    hostDisconnect: (deviceId) => ipcRenderer.invoke(LOCAL_CHANNEL.hostDisconnect, deviceId),
    hostDownload: (deviceId, path) => ipcRenderer.invoke(LOCAL_CHANNEL.hostDownload, deviceId, path),
    hostFileRead: (deviceId, path) => ipcRenderer.invoke(LOCAL_CHANNEL.hostFileRead, deviceId, path),
    hostFilesList: (deviceId, path, after) => ipcRenderer.invoke(LOCAL_CHANNEL.hostFilesList, deviceId, path, after),
    hostForgetKey: (deviceId) => ipcRenderer.invoke(LOCAL_CHANNEL.hostForgetKey, deviceId),
    hostRemove: (deviceId) => ipcRenderer.invoke(LOCAL_CHANNEL.hostRemove, deviceId),
    hostUpgrade: (deviceId) => ipcRenderer.invoke(LOCAL_CHANNEL.hostUpgrade, deviceId),
    onAcpChanged: (handler) => {
        const listener = () => handler();

        ipcRenderer.on(LOCAL_EVENT.acp, listener);

        return () => ipcRenderer.removeListener(LOCAL_EVENT.acp, listener);
    },
    onChanged: (handler) => {
        const listener = () => handler();

        ipcRenderer.on(LOCAL_EVENT.changed, listener);

        return () => ipcRenderer.removeListener(LOCAL_EVENT.changed, listener);
    },
    onPromptQueued: (handler) => {
        const listener = () => handler();

        ipcRenderer.on(LOCAL_EVENT.prompt, listener);

        return () => ipcRenderer.removeListener(LOCAL_EVENT.prompt, listener);
    },
    openHostTerminal: (deviceId) => ipcRenderer.invoke(LOCAL_CHANNEL.openHostTerminal, deviceId),
    openTerminal: (folder) => ipcRenderer.invoke(LOCAL_CHANNEL.openTerminal, folder),
    pickFolder: () => ipcRenderer.invoke(LOCAL_CHANNEL.pickFolder),
    promptAnswer: (id, answer) => ipcRenderer.invoke(LOCAL_CHANNEL.promptAnswer, id, answer),
    promptCurrent: () => ipcRenderer.invoke(LOCAL_CHANNEL.promptCurrent),
    promptSecret: (id, secret) => ipcRenderer.invoke(LOCAL_CHANNEL.promptSecret, id, secret),
    settingsGet: () => ipcRenderer.invoke(LOCAL_CHANNEL.settingsGet),
    settingsUpdate: (update) => ipcRenderer.invoke(LOCAL_CHANNEL.settingsUpdate, update),
    terminalAvailability: () => ipcRenderer.invoke(LOCAL_CHANNEL.terminalAvailability),
    terminalSshAvailability: () => ipcRenderer.invoke(LOCAL_CHANNEL.terminalSshAvailability),
};

contextBridge.exposeInMainWorld("neoreDevice", api);
