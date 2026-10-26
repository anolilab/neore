/**
 * The only thing the web app can reach. Runs sandboxed: only `electron` and a
 * few built-ins can be required, so this file is bundled to one CJS file
 * (`scripts/build.mjs`). It exposes nothing on any origin but the site, and
 * every method is still checked against the sender in the main process.
 */
import type { IpcRendererEvent } from "electron";
import { contextBridge, ipcRenderer } from "electron";

import { CAPABILITIES_ARG, CHANNEL, SITE_ORIGIN_ARG } from "./channels.js";
import { DEVICE_CHANNEL } from "./device/channels.js";

const argument = (prefix: string): string | undefined => process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);

const siteOrigin = argument(SITE_ORIGIN_ARG);

/**
 * What the main process says this build can do. Read from the window's own
 * arguments, so it is known synchronously and cannot be set by the page.
 */
const capabilities = (argument(CAPABILITIES_ARG) ?? "").split(",").filter((name) => name !== "");

/** Subscribes to a main-process event; the returned function unsubscribes. */
const listen = <Payload>(channel: string, handler: (payload: Payload) => void): () => void => {
    const listener = (_event: IpcRendererEvent, payload: Payload) => handler(payload);

    ipcRenderer.on(channel, listener);

    return () => ipcRenderer.removeListener(channel, listener);
};

/**
 * The device RELAY only: status, pairing, manifest, execute and opening the local
 * window. Answering prompts and changing settings belong to the device window's
 * own preload, which the site cannot reach. Exposed only with the `device` capability.
 */
const deviceRelay = {
    execute: (call: { envelope: string; signature: string }) => ipcRenderer.invoke(DEVICE_CHANNEL.execute, call),
    manifest: () => ipcRenderer.invoke(DEVICE_CHANNEL.manifest),
    onChanged: (handler: () => void): () => void => listen(DEVICE_CHANNEL.changed, () => handler()),
    onProgress: (handler: (report: { callId: string; payload: string; signature: string }) => void): () => void =>
        listen(DEVICE_CHANNEL.progress, handler),
    openSettings: () => ipcRenderer.invoke(DEVICE_CHANNEL.openSettings),
    pair: (pairing: { accountLabel: string; deviceId: string; secret: string }) => ipcRenderer.invoke(DEVICE_CHANNEL.pair, pairing),
    status: () => ipcRenderer.invoke(DEVICE_CHANNEL.status),
};

if (siteOrigin !== undefined && document.location.origin === siteOrigin) {
    contextBridge.exposeInMainWorld("neoreNative", {
        /** What this build can do. The web side must read this, not assume it. */
        capabilities,
        device: capabilities.includes("device") ? deviceRelay : undefined,
        notify: (title: string, body?: string) => ipcRenderer.invoke(CHANNEL.notify, { body, title }),
        onCompose: (handler: () => void): () => void => listen(CHANNEL.compose, () => handler()),
        /** A deep link's text for the composer, which is not sent. Pair with `takePendingDraft`. */
        onDraft: (handler: () => void): () => void => listen(CHANNEL.draft, () => handler()),
        onFiles: (handler: () => void): () => void => listen(CHANNEL.files, () => handler()),
        onSignIn: (handler: () => void): () => void => listen(CHANNEL.signIn, () => handler()),
        /** Opens a thread in its own window. Exposed only with the `thread-windows` capability. */
        openThreadWindow: (threadId: string): Promise<void> => ipcRenderer.invoke(CHANNEL.openThreadWindow, threadId),
        /** Unread count for the dock / launcher badge; the main process clamps it to 0..999. */
        setBadge: (count: number): Promise<void> => ipcRenderer.invoke(CHANNEL.setBadge, count),
        startBrowserSignIn: (): Promise<void> => ipcRenderer.invoke(CHANNEL.startBrowserSignIn),
        takePendingCompose: (): Promise<string | undefined> => ipcRenderer.invoke(CHANNEL.takePendingCompose),
        takePendingDraft: (): Promise<string | undefined> => ipcRenderer.invoke(CHANNEL.takePendingDraft),
        takePendingFiles: (): Promise<{ data: Uint8Array; name: string }[]> => ipcRenderer.invoke(CHANNEL.takePendingFiles),
        takePendingSignIn: (): Promise<{ code: string; codeVerifier: string; redirectUri: string } | undefined> =>
            ipcRenderer.invoke(CHANNEL.takePendingSignIn),
    });
}
