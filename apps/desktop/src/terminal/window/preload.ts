/**
 * Preload of the LOCAL terminal window only. It exposes the terminal commands and nothing else.
 * Sandboxed: only `electron` can be required, so `scripts/build.mjs` bundles this to one CJS file.
 */
import { contextBridge, ipcRenderer } from "electron";

import { TERMINAL_CHANNEL, TERMINAL_EVENT } from "../channels";
import type { TerminalExit, TerminalWindowApi } from "./api";

const subscribe = <Payload>(channel: string, handler: (payload: Payload) => void): () => void => {
    const listener = (_event: unknown, payload: Payload) => handler(payload);

    ipcRenderer.on(channel, listener);

    return () => ipcRenderer.removeListener(channel, listener);
};

const api: TerminalWindowApi = {
    ack: (chars) => ipcRenderer.invoke(TERMINAL_CHANNEL.ack, chars),
    copy: (text) => ipcRenderer.invoke(TERMINAL_CHANNEL.copy, text),
    input: (data) => ipcRenderer.invoke(TERMINAL_CHANNEL.input, data),
    onData: (handler) => subscribe<string>(TERMINAL_EVENT.data, handler),
    onExit: (handler) => subscribe<TerminalExit>(TERMINAL_EVENT.exit, handler),
    paste: () => ipcRenderer.invoke(TERMINAL_CHANNEL.paste),
    resize: (cols, rows) => ipcRenderer.invoke(TERMINAL_CHANNEL.resize, { cols, rows }),
    start: (cols, rows) => ipcRenderer.invoke(TERMINAL_CHANNEL.start, { cols, rows }),
};

contextBridge.exposeInMainWorld("neoreTerminal", api);
