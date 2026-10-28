/**
 * Device execution in the Electron main process: the windows, the commands and the
 * events. The logic lives in `device-core`.
 *
 * Two sets of channels, two trust checks:
 * - `DEVICE_CHANNEL` (relay): reachable from the site's main window only, through `options.isTrusted`.
 * The site may verify and relay; it cannot approve.
 * - `LOCAL_CHANNEL` (approvals, folders, MCP servers, audit): reachable from the device window alone,
 * which is a separate BrowserWindow with its own preload and a file: URL. The site cannot reach these,
 * and the device window cannot reach the relay (`isTrusted` rejects its frame).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { BrowserWindow as BrowserWindowInstance, IpcMainInvokeEvent, WebContents } from "electron";
import { app, BrowserWindow, dialog, ipcMain, Notification } from "electron";

import { DEVICE_CHANNEL, LOCAL_CHANNEL, LOCAL_EVENT } from "./channels";
import type { HostTransport } from "./transport";
import { createLocalTransport } from "./transport";
import type { CoreEvent, Prompt } from "./types";
import {
    readDeviceId,
    readHostPairing,
    readHostSpec,
    readOptionalDeviceId,
    readPairing,
    readPromptAnswer,
    readSecretAnswer,
    readSettingsUpdate,
    readSigned,
} from "./validate";

/** Stopping idle MCP servers runs once a minute. */
const REAP_INTERVAL_MS = 60_000;
const WINDOW_DIR = path.join(__dirname, "device-window");
const LOCAL_PAGE = path.join(WINDOW_DIR, "device.html");
const LOCAL_PRELOAD = path.join(WINDOW_DIR, "preload.cjs");

/**
 * Registers the device handlers. Returns whether the core loaded: the shell advertises `device` only then
 * (`main.ts`), so the page never sees a relay that would only answer "unavailable".
 */
export const registerDeviceIpc = (options: DeviceIpcOptions): boolean => {
    const state: {
        coreError?: unknown;
        local?: BrowserWindowInstance;
        transport?: HostTransport;
    } = {};
    /** Every site window that has made a trusted relay call and is still open: progress and changes go to each. */
    const sites = new Set<WebContents>();
    const localUrl = pathToFileURL(LOCAL_PAGE).href;

    const requireTransport = (): HostTransport => {
        if (state.transport === undefined) {
            throw new Error(`device execution is unavailable: ${String(state.coreError)}`);
        }

        return state.transport;
    };

    const send = (target: WebContents | undefined, channel: string, payload?: unknown): void => {
        if (target !== undefined && !target.isDestroyed()) {
            target.send(channel, payload);
        }
    };

    /** The device window while it is open; a dialog without a live window has no parent. */
    const liveLocal = (): BrowserWindowInstance | undefined => {
        if (state.local === undefined || state.local.isDestroyed()) {
            return undefined;
        }

        return state.local;
    };

    const openLocalWindow = (): void => {
        const live = liveLocal();

        if (live !== undefined) {
            if (live.isMinimized()) {
                live.restore();
            }

            live.show();
            live.focus();

            return;
        }

        const win = new BrowserWindow({
            alwaysOnTop: true,
            center: true,
            height: 600,
            minHeight: 420,
            minWidth: 420,
            title: "Neore — this computer",
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                preload: LOCAL_PRELOAD,
                sandbox: true,
                webSecurity: true,
                webviewTag: false,
            },
            width: 560,
        });

        win.webContents.setWindowOpenHandler(() => {
            return { action: "deny" };
        });
        // Same guards as every other window: a redirect or a webview cannot move the device window off its page.
        win.webContents.on("will-navigate", (event) => event.preventDefault());
        win.webContents.on("will-redirect", (event) => event.preventDefault());
        win.webContents.on("will-attach-webview", (event) => event.preventDefault());
        win.on("closed", () => {
            // Closing the window is a "no" to everything it was asking.
            state.local = undefined;
            state.transport?.denyPrompts();
        });
        win.loadFile(LOCAL_PAGE);
        state.local = win;
    };

    /** The device window's own main frame, loaded from our page and nothing else. */
    const isLocal = (event: IpcMainInvokeEvent): boolean => {
        const win = state.local;

        return (
            win !== undefined
            && !win.isDestroyed()
            && event.sender === win.webContents
            && event.senderFrame !== null
            && event.senderFrame === win.webContents.mainFrame
            && event.senderFrame.url === localUrl
        );
    };

    const relay = <Result>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Result): void => {
        ipcMain.handle(channel, (event, ...args) => {
            if (!options.isTrusted(event)) {
                throw new Error("device: untrusted sender");
            }

            if (!sites.has(event.sender)) {
                sites.add(event.sender);
                event.sender.once("destroyed", () => sites.delete(event.sender));
            }

            return handler(event, ...args);
        });
    };

    const local = <Result>(channel: string, handler: (...args: unknown[]) => Result): void => {
        ipcMain.handle(channel, (event, ...args) => {
            if (!isLocal(event)) {
                throw new Error("device: not the device window");
            }

            return handler(...args);
        });
    };

    const showPrompt = (prompt: Prompt): void => {
        openLocalWindow();
        send(state.local?.webContents, LOCAL_EVENT.prompt);

        const body = promptSummary(prompt);

        if (Notification.isSupported()) {
            new Notification({ body, title: "Neore is asking for your approval" }).show();
        }
    };

    const onEvent = (event: CoreEvent): void => {
        switch (event.type) {
            case "changed": {
                for (const site of sites) {
                    send(site, DEVICE_CHANNEL.changed);
                }

                break;
            }
            case "progress": {
                // The signed report; the page forwards it to the backend, which verifies it.
                for (const site of sites) {
                    send(site, DEVICE_CHANNEL.progress, { callId: event.callId, deviceId: event.deviceId, payload: event.payload, signature: event.signature });
                }

                break;
            }
            case "prompt": {
                showPrompt(event.prompt);
                break;
            }
            default: {
                break;
            }
        }
    };

    try {
        state.transport = createLocalTransport(app.getPath("userData"), onEvent);
    } catch (error) {
        // Register the handlers anyway: they reject with the reason, and the shell keeps running.
        state.coreError = error;
        console.error("[neore-desktop] device execution unavailable", error);
    }

    const reap = setInterval(() => {
        state.transport?.reapIdleServers();
    }, REAP_INTERVAL_MS);

    reap.unref();
    app.on("will-quit", () => {
        clearInterval(reap);
        state.transport?.stop();
    });

    // ─── Relay (site window) ───────────────────────────────────────────────

    relay(DEVICE_CHANNEL.status, () => requireTransport().status());

    relay(DEVICE_CHANNEL.pair, (_event, pairing) => {
        const { accountLabel, deviceId, secret } = readPairing(pairing);

        return requireTransport().pair(deviceId, secret, accountLabel);
    });

    relay(DEVICE_CHANNEL.manifest, async (_event, deviceId) => requireTransport().manifest(readOptionalDeviceId(deviceId)));

    // The servers this computer speaks for. The page asks; the host key, the passphrase and the pairing are each
    // decided by the person at the local window, so a page can connect nowhere on its own.
    relay(DEVICE_CHANNEL.hostProbe, async (_event, spec) => requireTransport().hostProbe(readHostSpec(spec)));

    relay(DEVICE_CHANNEL.hostPair, async (_event, pairing) => {
        const { deviceId, secret, spec } = readHostPairing(pairing);

        return requireTransport().hostPair(spec, deviceId, secret);
    });

    relay(DEVICE_CHANNEL.hostConnect, async (_event, deviceId) => requireTransport().hostConnect(readDeviceId(deviceId)));

    relay(DEVICE_CHANNEL.hostDisconnect, (_event, deviceId) => {
        requireTransport().hostDisconnect(readDeviceId(deviceId));
    });

    relay(DEVICE_CHANNEL.execute, async (_event, call) => {
        const { envelope, signature } = readSigned(call);

        return requireTransport().execute(envelope, signature);
    });

    relay(DEVICE_CHANNEL.openSettings, () => {
        openLocalWindow();
    });

    // ─── Local window (approvals, folders, MCP servers, audit) ─────────────

    local(LOCAL_CHANNEL.promptCurrent, () => requireTransport().promptCurrent());

    local(LOCAL_CHANNEL.promptAnswer, (id, answer) => {
        const checked = readPromptAnswer(id, answer);

        requireTransport().promptAnswer(checked.id, checked.answer);
    });

    // The passphrase has a channel of its own: it is not an answer, and nothing on the way logs it.
    local(LOCAL_CHANNEL.promptSecret, (id, secret) => {
        const checked = readSecretAnswer(id, secret);

        requireTransport().promptSecret(checked.id, checked.secret);
    });

    local(LOCAL_CHANNEL.hostConnect, async (deviceId) => requireTransport().hostConnect(readDeviceId(deviceId)));

    local(LOCAL_CHANNEL.hostDisconnect, (deviceId) => {
        requireTransport().hostDisconnect(readDeviceId(deviceId));
    });

    local(LOCAL_CHANNEL.hostForgetKey, (deviceId) => {
        requireTransport().hostForgetKey(readDeviceId(deviceId));
    });

    local(LOCAL_CHANNEL.hostRemove, (deviceId) => {
        requireTransport().hostRemove(readDeviceId(deviceId));
    });

    local(LOCAL_CHANNEL.settingsGet, () => requireTransport().settingsGet());

    local(
        LOCAL_CHANNEL.settingsUpdate,
        (update) =>
            // The core emits `changed` itself, so the site resends its manifest.
            requireTransport().settingsUpdate(readSettingsUpdate(update)),
    );

    local(LOCAL_CHANNEL.pickFolder, async () => {
        const dialogOptions = { properties: ["openDirectory" as const] };
        const parent = liveLocal();
        const result = parent === undefined ? await dialog.showOpenDialog(dialogOptions) : await dialog.showOpenDialog(parent, dialogOptions);

        return result.canceled ? null : result.filePaths[0] ?? null;
    });

    // A native dialog, so the page cannot draw a confirmation that looks like one.
    local(LOCAL_CHANNEL.confirm, async (message) => {
        const text = typeof message === "string" && message.length <= 1000 ? message : "";
        const dialogOptions = { buttons: ["Cancel", "OK"], cancelId: 0, defaultId: 1, message: text, type: "question" as const };
        const parent = liveLocal();
        const result = parent === undefined ? await dialog.showMessageBox(dialogOptions) : await dialog.showMessageBox(parent, dialogOptions);

        return result.response === 1;
    });

    local(LOCAL_CHANNEL.auditTail, () => requireTransport().auditTail());

    return state.transport !== undefined;
};

/** The one line a notification shows for a prompt. */
const promptSummary = ({ body }: Prompt): string => {
    switch (body.kind) {
        case "call": {
            return `${body.tool}${body.host === undefined ? "" : ` on ${body.host}`} — ${body.threadTitle}`;
        }
        case "hostConnect": {
            return `Connect to ${body.user}@${body.address}?`;
        }
        case "hostKey": {
            return `Trust the key of ${body.host}?`;
        }
        case "hostKeyChanged": {
            return `The key of ${body.host} changed`;
        }
        case "hostPairing": {
            return `Add the server ${body.name}`;
        }
        case "passphrase": {
            return `A key passphrase for ${body.host}`;
        }
        default: {
            return "Confirm pairing this computer";
        }
    }
};

export interface DeviceIpcOptions {
    /** True when the sender is the site's main window (see `trust.ts`). */
    isTrusted: (event: IpcMainInvokeEvent) => boolean;
}
