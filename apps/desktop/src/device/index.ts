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

import { AcpManager } from "../acp/manager";
import { coreGate } from "../acp/permission";
import { spawnAgent } from "../acp/process";
import type { AcpView, PermissionView, SpawnPlan } from "../acp/types";
import { loadDeviceCore } from "./addon";
import { DEVICE_CHANNEL, LOCAL_CHANNEL, LOCAL_EVENT } from "./channels";
import type { CoreEvent, DeviceCore, Prompt, Signed } from "./types";
import {
    readAcpUpdate,
    readAgentKey,
    readFolder,
    readOptionId,
    readPairing,
    readPrompt,
    readPromptAnswer,
    readRequestId,
    readRequestIds,
    readSessionId,
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
        acp?: AcpManager;
        core?: DeviceCore;
        coreError?: unknown;
        local?: BrowserWindowInstance;
    } = {};
    /** Every site window that has made a trusted relay call and is still open: progress and changes go to each. */
    const sites = new Set<WebContents>();
    const localUrl = pathToFileURL(LOCAL_PAGE).href;

    const requireCore = (): DeviceCore => {
        if (state.core === undefined) {
            throw new Error(`device execution is unavailable: ${String(state.coreError)}`);
        }

        return state.core;
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
            state.core?.denyPrompts();
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

        const body = prompt.body.kind === "pairing" ? "Confirm pairing this computer" : `${prompt.body.tool} — ${prompt.body.threadTitle}`;

        if (Notification.isSupported()) {
            new Notification({ body, title: "Neore is asking for your approval" }).show();
        }
    };

    const showAgentRequest = (agent: string, tool: string): void => {
        openLocalWindow();
        send(state.local?.webContents, LOCAL_EVENT.acp);

        if (Notification.isSupported()) {
            new Notification({ body: `${agent} — ${tool}`, title: "A coding agent is asking for your approval" }).show();
        }
    };

    const onEvent = (json: string): void => {
        const event = JSON.parse(json) as CoreEvent;

        switch (event.type) {
            case "acpPermission": {
                showAgentRequest(event.agent, event.tool);
                break;
            }
            case "changed": {
                for (const site of sites) {
                    send(site, DEVICE_CHANNEL.changed);
                }

                break;
            }
            case "progress": {
                // The signed report; the page forwards it to the backend, which verifies it.
                for (const site of sites) {
                    send(site, DEVICE_CHANNEL.progress, { callId: event.callId, payload: event.payload, signature: event.signature });
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
        const DeviceCoreClass = loadDeviceCore();

        state.core = new DeviceCoreClass(app.getPath("userData"), onEvent);
    } catch (error) {
        // Register the handlers anyway: they reject with the reason, and the shell keeps running.
        state.coreError = error;
        console.error("[neore-desktop] device execution unavailable", error);
    }

    const requireAcp = (): AcpManager => {
        const core = requireCore();

        // The core decides what may start: it refuses an unregistered agent and a folder that is not allowed.
        state.acp ??= new AcpManager({
            appVersion: app.getVersion(),
            gate: coreGate(core),
            onChange: () => send(state.local?.webContents, LOCAL_EVENT.acp),
            plan: (agentKey, folder) => JSON.parse(core.acpSpawnPlan(agentKey, folder)) as SpawnPlan,
            spawn: spawnAgent,
        });

        return state.acp;
    };

    const reap = setInterval(() => {
        state.core?.reapIdleServers();
    }, REAP_INTERVAL_MS);

    reap.unref();
    app.on("will-quit", () => {
        clearInterval(reap);
        // Synchronous: `will-quit` cannot await, and an agent left behind would outlive the app.
        state.acp?.killAll();
        state.core?.stop();
    });

    // ─── Relay (site window) ───────────────────────────────────────────────

    relay(DEVICE_CHANNEL.status, () => JSON.parse(requireCore().status()) as unknown);

    relay(DEVICE_CHANNEL.pair, (_event, pairing) => {
        const { accountLabel, deviceId, secret } = readPairing(pairing);

        return requireCore().pair(deviceId, secret, accountLabel);
    });

    relay(DEVICE_CHANNEL.manifest, async () => JSON.parse(await requireCore().manifest()) as Signed);

    relay(DEVICE_CHANNEL.execute, async (_event, call) => {
        const { envelope, signature } = readSigned(call);

        return JSON.parse(await requireCore().execute(envelope, signature)) as Signed;
    });

    relay(DEVICE_CHANNEL.openSettings, () => {
        openLocalWindow();
    });

    // ─── Local window (approvals, folders, MCP servers, audit) ─────────────

    local(LOCAL_CHANNEL.promptCurrent, () => {
        const json = requireCore().promptCurrent();

        return json === null ? null : (JSON.parse(json) as Prompt);
    });

    local(LOCAL_CHANNEL.promptAnswer, (id, answer) => {
        const checked = readPromptAnswer(id, answer);

        requireCore().promptAnswer(checked.id, checked.answer);
    });

    local(LOCAL_CHANNEL.settingsGet, () => JSON.parse(requireCore().settingsGet()) as unknown);

    local(
        LOCAL_CHANNEL.settingsUpdate,
        (update) =>
            // The core emits `changed` itself, so the site resends its manifest.
            JSON.parse(requireCore().settingsUpdate(readSettingsUpdate(update))) as unknown,
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

    local(LOCAL_CHANNEL.auditTail, () => requireCore().auditTail());

    // ─── Coding agents (ACP): registered, started and driven from this window only ─────

    local(LOCAL_CHANNEL.acpView, () => JSON.parse(requireCore().acpView()) as AcpView);

    local(LOCAL_CHANNEL.acpUpdate, (update) => JSON.parse(requireCore().acpUpdate(readAcpUpdate(update))) as AcpView);

    local(LOCAL_CHANNEL.acpProbe, (agentKey) => requireAcp().probe(readAgentKey(agentKey)));

    local(LOCAL_CHANNEL.acpStart, async (agentKey, folder) => {
        const key = readAgentKey(agentKey);
        const agent = (JSON.parse(requireCore().acpView()) as AcpView).agents.find((candidate) => candidate.key === key);

        if (agent === undefined) {
            throw new Error("that agent is not registered");
        }

        return requireAcp().startSession(key, agent.label, readFolder(folder));
    });

    local(LOCAL_CHANNEL.acpPermissions, () => JSON.parse(requireCore().acpPermissions()) as PermissionView[]);

    // Rust decides what an answer may be: the agent's own allow-once or reject-once option, for a request still
    // waiting. Nothing here, and nothing the window sends, can choose an "always" option.
    local(LOCAL_CHANNEL.acpPermissionAnswer, (id, optionId) => requireCore().acpPermissionAnswer(readRequestId(id), readOptionId(optionId)));

    local(LOCAL_CHANNEL.acpPermissionDecline, (id) => requireCore().acpPermissionDecline(readRequestId(id)));

    local(LOCAL_CHANNEL.acpPermissionAnswerBatch, (ids) => requireCore().acpPermissionAnswerBatch(readRequestIds(ids)));

    local(LOCAL_CHANNEL.acpSessions, () => requireAcp().summaries());

    local(LOCAL_CHANNEL.acpSession, (id) => requireAcp().snapshot(readSessionId(id)));

    local(LOCAL_CHANNEL.acpSend, (id, prompt) => requireAcp().send(readSessionId(id), readPrompt(prompt)));

    local(LOCAL_CHANNEL.acpCancel, (id) => requireAcp().cancel(readSessionId(id)));

    local(LOCAL_CHANNEL.acpClose, (id) => requireAcp().close(readSessionId(id)));

    local(LOCAL_CHANNEL.acpForget, (id) => requireAcp().remove(readSessionId(id)));

    return state.core !== undefined;
};

export interface DeviceIpcOptions {
    /** True when the sender is the site's main window (see `trust.ts`). */
    isTrusted: (event: IpcMainInvokeEvent) => boolean;
}
