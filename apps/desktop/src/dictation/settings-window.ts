/**
 * The dictation settings window in the Electron main process: a LOCAL page with its own sandboxed preload and its own in-memory
 * session. Only the tray opens it; the site has no way to open it, change a setting or start a download. Every handler answers
 * the settings window's own top frame on its own page and nobody else (`isOwnFrame`).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { BrowserWindow as BrowserWindowInstance, IpcMainInvokeEvent } from "electron";
import { BrowserWindow, ipcMain, session } from "electron";

import { isOwnFrame } from "../trust.js";
import { isDictationAsset } from "./permissions.js";
import type { SettingsApi } from "./settings-api.js";
import { SETTINGS_CHANNEL, SETTINGS_EVENT } from "./settings-channels.js";

const WINDOW_DIR = path.join(__dirname, "dictation-settings-window");
const PAGE = path.join(WINDOW_DIR, "settings.html");
const PRELOAD = path.join(WINDOW_DIR, "preload.cjs");
/** In memory (no `persist:` prefix), and its own: the page's rules are not the site's. */
const PARTITION = "dictation-settings";

export interface SettingsWindow {
    /** Tells an open window that a download or deletion ended. */
    changed: (message?: string) => void;
    /** Opens the window, or brings the open one forward. */
    open: () => void;
    /** Registers the channels. Call once. */
    register: () => void;
}

export interface SettingsWindowOptions {
    api: SettingsApi;
    log: (message: string) => void;
}

export const createSettingsWindow = ({ api, log }: SettingsWindowOptions): SettingsWindow => {
    const pageUrl = pathToFileURL(PAGE).href;
    const assetFolder = `${pathToFileURL(WINDOW_DIR).href}/`;
    let win: BrowserWindowInstance | undefined;
    let secured = false;

    const live = (): BrowserWindowInstance | undefined => win !== undefined && !win.isDestroyed() ? win : undefined;

    /** Nothing loads but the page's own files, and no permission is granted: the page needs none. */
    const secureSession = (): void => {
        if (secured) {
            return;
        }

        const ses = session.fromPartition(PARTITION);

        ses.webRequest.onBeforeRequest((details, callback) => {
            callback({ cancel: !isDictationAsset(assetFolder, details.url) });
        });
        ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        ses.setPermissionCheckHandler(() => false);
        secured = true;
    };

    const open = (): void => {
        const existing = live();

        if (existing !== undefined) {
            if (existing.isMinimized()) {
                existing.restore();
            }

            existing.show();
            existing.focus();

            return;
        }

        secureSession();

        const created = new BrowserWindow({
            center: true,
            height: 640,
            minHeight: 420,
            minWidth: 420,
            title: "Neore dictation settings",
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                partition: PARTITION,
                preload: PRELOAD,
                sandbox: true,
                spellcheck: false,
                webSecurity: true,
                webviewTag: false,
            },
            width: 520,
        });
        const { webContents } = created;

        webContents.setWindowOpenHandler(() => {
            return { action: "deny" };
        });
        webContents.on("will-navigate", (event) => event.preventDefault());
        webContents.on("will-redirect", (event) => event.preventDefault());
        webContents.on("will-attach-webview", (event) => event.preventDefault());
        created.on("closed", () => {
            if (win === created) {
                win = undefined;
            }
        });
        created.loadFile(PAGE);
        win = created;
    };

    const register = (): void => {
        const handle = <Result>(channel: string, handler: (...args: unknown[]) => Result | Promise<Result>): void => {
            ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
                if (!isOwnFrame(event, live()?.webContents, pageUrl)) {
                    log("dictation settings: ignored a call from a sender that is not the settings window");

                    throw new Error("dictation settings: not the settings window");
                }

                return handler(...args);
            });
        };

        handle(SETTINGS_CHANNEL.get, () => api.view());
        handle(SETTINGS_CHANNEL.update, async (payload) => {
            await api.update(payload);

            return api.view();
        });
        handle(SETTINGS_CHANNEL.download, async (id) => {
            api.download(id);

            return api.view();
        });
        handle(SETTINGS_CHANNEL.remove, async (id) => {
            await api.remove(id);

            return api.view();
        });
    };

    return {
        changed: (message) => {
            live()?.webContents.send(SETTINGS_EVENT.changed, message);
        },
        open,
        register,
    };
};
