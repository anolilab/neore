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

import type { AcpCommand, AppliedCall } from "../acp/commands";
import { HELD, HostCommands, isAcpEnvelope } from "../acp/commands";
import { EarlySends, NEVER_OPENED } from "../acp/early-sends";
import { AcpImporter } from "../acp/import";
import { HostPoster } from "../acp/ingest";
import { AgentInstaller } from "../acp/install";
import { AcpManager } from "../acp/manager";
import { coreGate } from "../acp/permission";
import { acpSupported, spawnAgent } from "../acp/process";
import { AgentRegistry } from "../acp/registry";
import type { AcpView, PermissionView, SpawnPlan } from "../acp/types";
import { backendOrigin } from "../site";
import type { TerminalOpener } from "../terminal/index";
import { DEVICE_CHANNEL, LOCAL_CHANNEL, LOCAL_EVENT } from "./channels";
import type { HostTransport } from "./transport";
import { createLocalTransport } from "./transport";
import type { CoreEvent, DeviceCore, Prompt } from "./types";
import {
    readAcpUpdate,
    readAgentKey,
    readAgentVersion,
    readDeviceId,
    readFolder,
    readHostPairing,
    readHostSpec,
    readNativeSessionId,
    readOptionalDeviceId,
    readOptionId,
    readPairing,
    readPrompt,
    readPromptAnswer,
    readRequestId,
    readRequestIds,
    readSearchQuery,
    readSecretAnswer,
    readSessionId,
    readSessionTitle,
    readSettingsUpdate,
    readSigned,
} from "./validate";

/** Stopping idle MCP servers runs once a minute. */
const REAP_INTERVAL_MS = 60_000;
const WINDOW_DIR = path.join(__dirname, "device-window");
const LOCAL_PAGE = path.join(WINDOW_DIR, "device.html");
const LOCAL_PRELOAD = path.join(WINDOW_DIR, "preload.cjs");

/** The folder with the `neore-host` binaries and checksums this build ships: in the app's resources once packaged. */
const hostBundleDirectory = (): string | undefined => (app.isPackaged ? path.join(process.resourcesPath, "neore-host") : process.env.NEORE_HOST_BUNDLE);

/**
 * Registers the device handlers. Returns whether the core loaded: the shell advertises `device` only then
 * (`main.ts`), so the page never sees a relay that would only answer "unavailable".
 */
export const registerDeviceIpc = (options: DeviceIpcOptions): boolean => {
    const state: {
        acp?: AcpManager;
        commands?: HostCommands;
        core?: DeviceCore;
        coreError?: unknown;
        early?: EarlySends;
        host?: HostPoster;
        importer?: AcpImporter;
        installer?: AgentInstaller;
        local?: BrowserWindowInstance;
        registry?: AgentRegistry;
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

    /** The coding-agent handlers drive the local core directly: agents run on this computer only. */
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
            state.transport?.denyPrompts();
        });
        win.loadFile(LOCAL_PAGE);
        state.local = win;
    };

    /** The device window's own main frame, loaded from our page and nothing else. */
    const isLocal = (event: IpcMainInvokeEvent): boolean => {
        const win = state.local;

        return (
            win !== undefined &&
            !win.isDestroyed() &&
            event.sender === win.webContents &&
            event.senderFrame !== null &&
            event.senderFrame === win.webContents.mainFrame &&
            event.senderFrame.url === localUrl
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

    const showAgentRequest = (agent: string, tool: string): void => {
        openLocalWindow();
        send(state.local?.webContents, LOCAL_EVENT.acp);

        if (Notification.isSupported()) {
            new Notification({ body: `${agent} — ${tool}`, title: "A coding agent is asking for your approval" }).show();
        }
    };

    const onEvent = (event: CoreEvent): void => {
        switch (event.type) {
            case "acpPermission": {
                showAgentRequest(event.agent, event.tool);
                break;
            }
            case "acpPermissionsChanged": {
                // A remote answer took a request out of the queue: the window reads the list again.
                send(state.local?.webContents, LOCAL_EVENT.acp);
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

    /** Saves what the agents do on the backend, from here and not from the page. Without a pairing it posts nothing. */
    const requireHost = (core: DeviceCore): HostPoster => {
        state.host ??= new HostPoster({
            // The turn may be running, queued in the session, or still held for a session that is opening.
            cancelTurn: (sessionId, turnId) => {
                state.acp?.cancelTurn(sessionId, turnId);
                state.early?.cancel(sessionId, turnId);
            },
            deviceId: () => (JSON.parse(core.status()) as { deviceId: string | null }).deviceId ?? undefined,
            endpoint: new URL("hosts/ingest", backendOrigin()),
            log: (message) => console.error(message),
            sign: (payload) => core.signTurn(payload),
            stateFile: path.join(app.getPath("userData"), "acp-host-turns.json"),
        });

        return state.host;
    };

    try {
        const created = createLocalTransport(app.getPath("userData"), onEvent, hostBundleDirectory());

        state.transport = created;
        state.core = created.core;
    } catch (error) {
        // Register the handlers anyway: they reject with the reason, and the shell keeps running.
        state.coreError = error;
        console.error("[neore-desktop] device execution unavailable", error);
    }

    /** The id and label of the folder the user approved for this agent, never its path. */
    const approvedFolder = (core: DeviceCore, agentKey: string, folder: string): { folderId: string; folderLabel: string } | undefined => {
        const consent = (JSON.parse(core.acpView()) as AcpView).consents.find(
            (candidate) => candidate.agentKey === agentKey && candidate.folderPath === folder,
        );

        return consent === undefined ? undefined : { folderId: consent.folderId, folderLabel: consent.folderLabel };
    };

    const requireAcp = (): AcpManager => {
        const core = requireCore();

        const host = requireHost(core);

        // The core decides what may start: it refuses an unregistered agent and a folder that is not allowed.
        state.acp ??= new AcpManager({
            appVersion: app.getVersion(),
            gate: coreGate(core),
            hostInfo: (agentKey, folder) => approvedFolder(core, agentKey, folder),
            log: (message) => console.error(message),
            observer: host,
            onChange: () => send(state.local?.webContents, LOCAL_EVENT.acp),
            plan: (agentKey, folder) => JSON.parse(core.acpSpawnPlan(agentKey, folder)) as SpawnPlan,
            spawn: spawnAgent,
        });

        return state.acp;
    };

    /** Imports an agent's saved sessions: the agent is started in an approved folder, and the transcript goes to the backend from here. */
    const requireImporter = (): AcpImporter => {
        const core = requireCore();

        state.importer ??= new AcpImporter({
            agentLabel: (agentKey) => (JSON.parse(core.acpView()) as AcpView).agents.find((agent) => agent.key === agentKey)?.label,
            agents: requireAcp(),
            hostInfo: (agentKey, folder) => approvedFolder(core, agentKey, folder),
            io: requireHost(core).importIo(),
        });

        return state.importer;
    };

    /** Messages that arrived before their session opened (`acp/early-sends.ts`). */
    const requireEarly = (): EarlySends => {
        const core = requireCore();

        state.early ??= new EarlySends({
            finished: (callId) => {
                state.commands?.finished(callId);
            },
            log: (message) => console.error(message),
            observer: requireHost(core),
            send: (sessionId, text, turnId) => {
                requireAcp().send(sessionId, text, turnId);
            },
            statusOf: (sessionId) => state.acp?.statusOf(sessionId),
        });

        return state.early;
    };

    /** Opens the session the backend asked for; the command's receipt stays open until it has opened or failed, and the messages held for it follow. */
    const startRequestedSession = async (command: Extract<AcpCommand, { kind: "start" }>, call: AppliedCall): Promise<void> => {
        try {
            const sessionId = await requireAcp().startSession(command.agentKey, command.agentLabel, command.folderPath, {
                sessionId: command.sessionId,
                threadId: command.threadId,
            });

            requireEarly().opened(sessionId);
        } catch (error) {
            console.error("[neore-desktop] a requested coding agent did not start:", (error as Error).message);
            requireEarly().failed(command.sessionId, (error as Error).message);
        } finally {
            await state.commands?.finished(call.callId);
        }
    };

    /** Carries out one command the backend sent, after its receipt is written (`acp/commands.ts`). */
    const applyCommand = (command: AcpCommand, call: AppliedCall): "accepted" | typeof HELD => {
        const core = requireCore();

        switch (command.kind) {
            case "cancel": {
                // The turn may have ended already; that is not a refusal.
                requireAcp().cancelTurn(command.sessionId, command.turnId);
                requireEarly().cancel(command.sessionId, command.turnId);

                return "accepted";
            }
            case "permissionAnswer": {
                core.acpPermissionAnswerRemote(command.sessionId, command.requestId, command.optionId);

                return "accepted";
            }
            case "send": {
                // Sent now, or held until the session opens (`acp/early-sends.ts`).
                return requireEarly().submit(command, call);
            }
            case "start": {
                // The agent takes a while to start. The command is accepted now and stays in the receipt log until the
                // agent has opened (or failed to); the backend learns the session is open from its own `session_open`.
                startRequestedSession(command, call);

                return HELD;
            }
            default: {
                throw new Error("unknown command");
            }
        }
    };

    const requireCommands = (): HostCommands => {
        state.commands ??= new HostCommands({
            apply: applyCommand,
            core: requireCore(),
            interrupted: (held) => requireHost(requireCore()).endLapsedTurn(held.sessionId, held.turnId, held.threadId, { reason: "interrupted" }),
            lapsed: (held) => requireHost(requireCore()).endLapsedTurn(held.sessionId, held.turnId, held.threadId, { error: NEVER_OPENED, reason: "failed" }),
            log: (message) => console.error(message),
            receiptFile: path.join(app.getPath("userData"), "acp-host-receipts.json"),
        });

        return state.commands;
    };

    /**
     * Commands a previous run left unfinished go first, so a turn they own is not ended as `interrupted`; then a turn it
     * was cut off in ends as `interrupted`, whether or not an agent is started this time.
     */
    const recoverFromRestart = async (core: DeviceCore): Promise<void> => {
        const host = requireHost(core);
        // Read first: the replay opens channels, and the first of them rewrites the file of running turns.
        const leftovers = await host.readLeftovers();

        await requireCommands().recover();
        await host.recover(leftovers);
    };

    if (state.core !== undefined) {
        recoverFromRestart(state.core);
    }

    const reap = setInterval(() => {
        state.transport?.reapIdleServers();
    }, REAP_INTERVAL_MS);

    reap.unref();
    app.on("will-quit", () => {
        clearInterval(reap);
        // Synchronous: `will-quit` cannot await, and an agent left behind would outlive the app.
        state.acp?.killAll();
        state.host?.stop();
        state.transport?.stop();
    });

    // ─── Relay (site window) ───────────────────────────────────────────────

    const pairAndOpenSessions = async (deviceId: string, secret: string, accountLabel: string): Promise<boolean> => {
        const paired = await requireTransport().pair(deviceId, secret, accountLabel);

        // Sessions opened before pairing stayed on this computer; they open on the backend now.
        // A declined pairing keeps the existing one: nothing to open.
        if (paired) {
            state.host?.paired();
        }

        return paired;
    };

    relay(DEVICE_CHANNEL.status, () => requireTransport().status());

    relay(DEVICE_CHANNEL.pair, (_event, pairing) => {
        const { accountLabel, deviceId, secret } = readPairing(pairing);

        return pairAndOpenSessions(deviceId, secret, accountLabel);
    });

    relay(DEVICE_CHANNEL.manifest, async (_event, deviceId) => requireTransport().manifest(readOptionalDeviceId(deviceId)));

    // The servers this computer speaks for. The page asks; the connection itself, the host key, the passphrase and the pairing are each
    // decided by the person at the local window, so a page can connect nowhere on its own.
    relay(DEVICE_CHANNEL.hostProbe, async (_event, spec) => requireTransport().hostProbe(readHostSpec(spec)));

    relay(DEVICE_CHANNEL.hostPair, async (_event, pairing) => {
        const { deviceId, secret, spec } = readHostPairing(pairing);

        return requireTransport().hostPair(spec, deviceId, secret);
    });

    relay(DEVICE_CHANNEL.hostConnect, async (_event, deviceId) => requireTransport().hostConnect(readDeviceId(deviceId), false));

    relay(DEVICE_CHANNEL.hostDisconnect, (_event, deviceId) => {
        requireTransport().hostDisconnect(readDeviceId(deviceId));
    });

    relay(DEVICE_CHANNEL.execute, async (_event, call) => {
        const { envelope, signature } = readSigned(call);

        // A coding-agent command is not a device tool: it has no prompt of its own, and its receipt is written here.
        if (isAcpEnvelope(envelope)) {
            return await requireCommands().execute(envelope, signature);
        }

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

    local(LOCAL_CHANNEL.hostConnect, async (deviceId) => requireTransport().hostConnect(readDeviceId(deviceId), true));

    local(LOCAL_CHANNEL.hostDisconnect, (deviceId) => {
        requireTransport().hostDisconnect(readDeviceId(deviceId));
    });

    local(LOCAL_CHANNEL.hostForgetKey, (deviceId) => {
        requireTransport().hostForgetKey(readDeviceId(deviceId));
    });

    // Local window only: it puts software on a server and removes its older versions, so a page cannot ask for it.
    local(LOCAL_CHANNEL.hostUpgrade, async (deviceId) => requireTransport().hostUpgrade(readDeviceId(deviceId)));

    local(LOCAL_CHANNEL.hostRemove, (deviceId) => {
        requireTransport().hostRemove(readDeviceId(deviceId));
    });

    local(LOCAL_CHANNEL.settingsGet, () => requireTransport().settingsGet());

    local(LOCAL_CHANNEL.settingsUpdate, (update) =>
        // The core emits `changed` itself, so the site resends its manifest.
        requireTransport().settingsUpdate(readSettingsUpdate(update)),
    );

    local(LOCAL_CHANNEL.pickFolder, async () => {
        const dialogOptions = { properties: ["openDirectory" as const] };
        const parent = liveLocal();
        const result = parent === undefined ? await dialog.showOpenDialog(dialogOptions) : await dialog.showOpenDialog(parent, dialogOptions);

        return result.canceled ? null : (result.filePaths[0] ?? null);
    });

    // A native dialog, so the page cannot draw a confirmation that looks like one.
    local(LOCAL_CHANNEL.confirm, async (message) => {
        // A message that is not shown whole is not confirmed: an empty dialog with OK as the default would approve nothing readable.
        if (typeof message !== "string" || message.length > 1000) {
            return false;
        }

        const dialogOptions = { buttons: ["Cancel", "OK"], cancelId: 0, defaultId: 1, message, type: "question" as const };
        const parent = liveLocal();
        const result = parent === undefined ? await dialog.showMessageBox(dialogOptions) : await dialog.showMessageBox(parent, dialogOptions);

        return result.response === 1;
    });

    local(LOCAL_CHANNEL.auditTail, () => requireTransport().auditTail());

    // ─── Coding agents (ACP): registered, started and driven from this window only ─────

    local(LOCAL_CHANNEL.acpView, () => JSON.parse(requireCore().acpView()) as AcpView);

    const updateAcp = async (update: string): Promise<AcpView> => {
        const view = JSON.parse(requireCore().acpUpdate(update)) as AcpView;
        const { key, op } = JSON.parse(update) as { key?: string; op?: string };

        // What an agent reported says nothing about a different program.
        if (key !== undefined && (op === "saveAgent" || op === "removeAgent")) {
            state.acp?.forgetReport(key);
        }

        // A running agent was started under an approval this update may have taken away.
        await state.acp?.closeUnapproved(view);

        return view;
    };

    local(LOCAL_CHANNEL.acpUpdate, (update) => updateAcp(readAcpUpdate(update)));

    // The registry is read when the window searches, never otherwise: there is no timer and no check of installed
    // agents against it, so nothing updates an agent but an install the user confirms again.
    const requireRegistry = (): AgentRegistry => {
        state.registry ??= new AgentRegistry({ fetch: options.fetch, supported: acpSupported });

        return state.registry;
    };

    local(LOCAL_CHANNEL.acpRegistrySearch, (query) => requireRegistry().search(readSearchQuery(query)));

    local(LOCAL_CHANNEL.acpRegistryInstall, async (id, version) => {
        state.installer ??= new AgentInstaller({
            // A native dialog worded here from the registry entry, not by the window.
            confirm: async ({ detail, message }) => {
                const dialogOptions = { buttons: ["Cancel", "Install"], cancelId: 0, defaultId: 0, detail, message, noLink: true, type: "question" as const };
                const parent = liveLocal();
                const result = parent === undefined ? await dialog.showMessageBox(dialogOptions) : await dialog.showMessageBox(parent, dialogOptions);

                return result.response === 1;
            },
            core: requireCore,
            fetch: options.fetch,
            registry: requireRegistry(),
        });

        const key = readAgentKey(id);
        const view = await state.installer.install(key, readAgentVersion(version));

        if (view !== null) {
            state.acp?.forgetReport(key);
            // A reinstall drops the folder approvals of the old version; a running session was started under them.
            await state.acp?.closeUnapproved(view);
            // Only now, with nothing running from it, does the old version's folder go.
            requireCore().acpInstallPrune(key);
        }

        return view;
    });

    local(LOCAL_CHANNEL.acpProbe, (agentKey) => requireAcp().probe(readAgentKey(agentKey)));

    local(LOCAL_CHANNEL.acpReports, () => requireAcp().allReports());

    local(LOCAL_CHANNEL.acpImportList, (agentKey, folder) => requireImporter().list(readAgentKey(agentKey), readFolder(folder)));

    local(LOCAL_CHANNEL.acpImport, (agentKey, folder, nativeSessionId, title) =>
        requireImporter().import(readAgentKey(agentKey), readFolder(folder), readNativeSessionId(nativeSessionId), readSessionTitle(title)),
    );

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

    // The terminal is the user's own shell, opened by a click in this window. The folder is checked by the terminal module.
    local(LOCAL_CHANNEL.terminalAvailability, () => options.terminal?.availability ?? { available: false, reason: "The terminal is not available." });
    local(LOCAL_CHANNEL.terminalSshAvailability, () => options.terminal?.sshAvailability ?? { available: false, reason: "The terminal is not available." });

    local(LOCAL_CHANNEL.openTerminal, async (folder) => {
        if (options.terminal === undefined) {
            throw new Error("The terminal is not available.");
        }

        if (folder !== null && typeof folder !== "string") {
            throw new Error("device: folder is invalid");
        }

        await options.terminal.open(folder);
    });

    // A shell on a paired server: connecting it first is what asks to trust its key, so a server that is not trusted
    // gets no window. The shell itself is the terminal module's, and rides the connection this opens.
    local(LOCAL_CHANNEL.openHostTerminal, async (deviceId) => {
        if (options.terminal === undefined) {
            throw new Error("The terminal is not available.");
        }

        const id = readDeviceId(deviceId);
        const host = requireTransport()
            .settingsGet()
            .hosts.find((candidate) => candidate.deviceId === id);

        if (host === undefined) {
            throw new Error("device: that server is not paired with this computer");
        }

        await options.terminal.openSsh({
            args: () => requireTransport().hostTerminal(id),
            attach: () => requireTransport().hostTerminalAttach(id),
            deviceId: id,
            label: `${host.user}@${host.address}`,
        });
    });

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
    /** Replaces `fetch` for the registry and its downloads; tests only. */
    fetch?: typeof fetch;
    /** True when the sender is the site's main window (see `trust.ts`). */
    isTrusted: (event: IpcMainInvokeEvent) => boolean;
    /** Opens a terminal from the device window. Absent in tests that do not cover it. */
    terminal?: TerminalOpener;
}
