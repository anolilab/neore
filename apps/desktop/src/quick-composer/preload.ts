/**
 * The Quick Composer's preload: two functions, nothing else. It is a local
 * page, so it is never given the site bridge. The main process checks that
 * each call comes from this page's own URL (`trust.ts#isLocalPage`).
 */
import { contextBridge, ipcRenderer } from "electron";

import { CHANNEL } from "../channels";

contextBridge.exposeInMainWorld("neoreQuickComposer", {
    closeQuickComposer: (): Promise<void> => ipcRenderer.invoke(CHANNEL.closeQuickComposer),
    quickCompose: (text: string): Promise<void> => ipcRenderer.invoke(CHANNEL.quickCompose, text),
});
