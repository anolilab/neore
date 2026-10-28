/**
 * On-device dictation in the Electron main process: the shortcut, the capture window, the model store and the helper.
 * The logic is in `controller.ts`; this file is the Electron side of it. It is opt-in (`settings.ts`, changed in the local
 * settings window): with the switch off the shortcut is not held and no window, download or helper ever starts.
 *
 * The capture window is a LOCAL page with its own sandboxed preload and its own in-memory session, which loads
 * nothing but its own files. Its audio goes to the main process in memory, to a helper process on stdin. Nothing is written to disk and
 * nothing leaves the machine. Downloading the model is the main process's job: this window has no network.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { BrowserWindow as BrowserWindowInstance, IpcMainEvent, Session } from "electron";
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, net, Notification, session, systemPreferences } from "electron";

import type { ModelSpec } from "./catalog.js";
import { offeredModels, resolveModel } from "./catalog.js";
import type { CaptureFailure } from "./channels.js";
import { CAPTURE_FAILURES, DICTATION_CHANNEL, DICTATION_EVENT } from "./channels.js";
import type { CaptureWindow, DictationController } from "./controller.js";
import { createDictationController } from "./controller.js";
import { DICTATION_SHORTCUT, DICTATION_SHORTCUT_LABEL, isCancel, isChordRelease } from "./hold.js";
import { insertDictation } from "./insert.js";
import { createModelStore } from "./model-store.js";
import type { PermissionPolicy } from "./permissions.js";
import { createPermissionPolicy, isDictationAsset } from "./permissions.js";
import type { HelperCommand, Recognizer } from "./recognizer.js";
import { startRecognizer } from "./recognizer.js";
import { createSettingsStore } from "./settings.js";
import { createSettingsApi } from "./settings-api.js";
import { createSettingsWindow } from "./settings-window.js";

const WINDOW_DIR = path.join(__dirname, "dictation-window");
const PAGE = path.join(WINDOW_DIR, "dictation.html");
const PRELOAD = path.join(WINDOW_DIR, "preload.cjs");
/** An in-memory session (no `persist:` prefix): the page keeps nothing between dictations, and its rules are its own. */
const PARTITION = "dictation";
/** How long to wait for the page to hand over its last chunk after a stop. */
const STOP_TIMEOUT_MS = 1500;
const MAX_CHUNK_BYTES = 65_536;
/** After a cancel, how long a delete waits for the helper to let go of its model file. */
const HELPER_EXIT_WAIT_MS = 3000;

/** What the e2e suite drives and reads through `app.evaluate`. Test hooks exist only in an unpackaged build. */
export interface DictationProbe {
    audioBytes: number;
    begin?: () => void;
    cancel?: () => void;
    end?: () => void;
    helperPid: () => number | undefined;
    openSettings?: () => void;
    outcome: () => string | undefined;
    state: () => string;
    /** Replaces the recogniser and its model with these, skipping the model store. */
    useTestEngine?: (engine: { args: string[]; command: string; modelPath: string }) => void;
}

export interface DictationOptions {
    /** Can the main window put text in its composer right now? */
    canTakeDraft: () => boolean;
    handOffDraft: (text: string) => void;
    /** Is this a page of the site, on its trusted origin? */
    isSiteUrl: (url: string | undefined) => boolean;
    log: (message: string) => void;
    /** What a site page may be granted. */
    sitePermissions: ReadonlySet<string>;
}

export interface Dictation {
    /** Is this the live capture window's own contents, asking from its own page? Feeds the permission policy. */
    isWindow: (webContents: unknown, url: string | undefined) => boolean;
    /** Opens the local settings window (the tray's item): the only way in, the site has none. */
    openSettings: () => void;
    /** The one permission policy, for the default session and the capture window's own. */
    policy: PermissionPolicy;
    probe: DictationProbe | undefined;
    /** Registers the channels, and the shortcut while the switch is on and the helper was built. */
    register: () => void;
}

/** electron-builder's `${os}` for this platform: the folder name `scripts/build-dictation-helper.mjs` writes. */
const BUILDER_OS: Partial<Record<NodeJS.Platform, string>> = { darwin: "mac", linux: "linux", win32: "win" };

const helperPath = (): string => {
    const executable = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";

    return app.isPackaged
        ? path.join(process.resourcesPath, "dictation", executable)
        : path.join(__dirname, "..", "helper", `${BUILDER_OS[process.platform] ?? process.platform}-${process.arch}`, executable);
};

const toBuffer = (payload: unknown): Buffer | undefined => {
    let bytes: Uint8Array | undefined;

    if (payload instanceof ArrayBuffer) {
        bytes = new Uint8Array(payload);
    } else if (payload instanceof Uint8Array) {
        bytes = payload;
    }

    // 16-bit samples: an odd length is not audio, and one chunk is a few KiB, never megabytes.
    if (bytes === undefined || bytes.byteLength === 0 || bytes.byteLength % 2 !== 0 || bytes.byteLength > MAX_CHUNK_BYTES) {
        return undefined;
    }

    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};

const notify = (title: string, body: string): void => {
    new Notification({ body, title }).show();
};

export const createDictation = (options: DictationOptions): Dictation => {
    const pageUrl = pathToFileURL(PAGE).href;
    const assetFolder = `${pathToFileURL(WINDOW_DIR).href}/`;
    const offered = offeredModels(process.platform, process.arch);
    const dictationFolder = path.join(app.getPath("userData"), "dictation");
    const settings = createSettingsStore(path.join(dictationFolder, "settings.json"), new Set(offered.map(({ spec }) => spec.id)));
    const models = createModelStore({ directory: path.join(dictationFolder, "models"), fetch: (url, init) => net.fetch(String(url), init) });
    const chosenModel = () => resolveModel(settings.get().model, process.platform, process.arch);
    let shortcutHeld = false;
    /** The OS refused the shortcut (another app holds it): settings says so instead of leaving the switch looking healthy. */
    let shortcutRefused = false;
    let capture: BrowserWindowInstance | undefined;
    let ended: (() => void) | undefined;
    let recognizer: Recognizer | undefined;
    let testEngine: { args: string[]; command: string; modelPath: string } | undefined;
    let controller: DictationController | undefined;
    let secured: Session | undefined;
    const probe: DictationProbe = {
        audioBytes: 0,
        helperPid: () => recognizer?.pid,
        outcome: () => controller?.lastOutcome(),
        state: () => controller?.state() ?? "idle",
    };

    const policy = createPermissionPolicy({
        isDictationWindow: (webContents, url) => isWindow(webContents, url),
        isSiteUrl: options.isSiteUrl,
        sitePermissions: options.sitePermissions,
    });
    const liveWindow = (): BrowserWindowInstance | undefined => capture !== undefined && !capture.isDestroyed() ? capture : undefined;

    const isWindow = (webContents: unknown, url: string | undefined): boolean => {
        const win = liveWindow();

        return win !== undefined && webContents === win.webContents && url === pageUrl;
    };

    /** The frame behind an IPC call is the capture window's own top frame, on its own page. */
    const isFromWindow = (event: IpcMainEvent): boolean => {
        const win = liveWindow();

        return win !== undefined && event.sender === win.webContents && event.senderFrame != null && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === pageUrl;
    };

    /** Locks the window's session: nothing loads but its own files, and the policy decides every permission. */
    const secureSession = (): Session => {
        if (secured !== undefined) {
            return secured;
        }

        const ses = session.fromPartition(PARTITION);

        ses.webRequest.onBeforeRequest((details, callback) => {
            callback({ cancel: !isDictationAsset(assetFolder, details.url) });
        });
        ses.setPermissionRequestHandler(policy.request);
        ses.setPermissionCheckHandler(policy.check);
        secured = ses;

        return ses;
    };

    const openWindow = (): CaptureWindow => {
        secureSession();
        probe.audioBytes = 0;

        const win = new BrowserWindow({
            alwaysOnTop: true,
            center: true,
            frame: false,
            fullscreenable: false,
            height: 96,
            maximizable: false,
            minimizable: false,
            resizable: false,
            skipTaskbar: true,
            title: "Neore dictation",
            webPreferences: {
                autoplayPolicy: "no-user-gesture-required",
                contextIsolation: true,
                nodeIntegration: false,
                partition: PARTITION,
                preload: PRELOAD,
                sandbox: true,
                spellcheck: false,
                webSecurity: true,
                webviewTag: false,
            },
            width: 300,
        });
        const { webContents } = win;

        webContents.setWindowOpenHandler(() => {
            return { action: "deny" };
        });
        webContents.on("will-navigate", (event) => event.preventDefault());
        webContents.on("will-redirect", (event) => event.preventDefault());
        webContents.on("will-attach-webview", (event) => event.preventDefault());
        // The window has the keyboard focus, so it sees the key come up: that is the release (`globalShortcut` reports presses only).
        webContents.on("before-input-event", (event, input) => {
            if (isChordRelease(input)) {
                controller?.release();
            } else if (isCancel(input)) {
                event.preventDefault();
                controller?.cancel();
            }
        });
        // Focus moving elsewhere means the key cannot be seen any more: that ends it too.
        win.on("blur", () => controller?.release());
        win.on("closed", () => {
            if (capture === win) {
                capture = undefined;
            }

            controller?.windowClosed();
        });
        win.loadFile(PAGE);

        if (process.platform === "darwin") {
            app.focus({ steal: true });
        }

        win.focus();
        capture = win;

        return {
            close: () => {
                if (!win.isDestroyed()) {
                    win.destroy();
                }
            },
            stop: () =>
                new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, STOP_TIMEOUT_MS);

                    ended = () => {
                        clearTimeout(timer);
                        resolve();
                    };

                    if (!win.isDestroyed()) {
                        webContents.send(DICTATION_EVENT.stop);
                    }
                }),
        };
    };

    const helper = (): HelperCommand => testEngine === undefined ? { args: [], command: helperPath() } : { args: testEngine.args, command: testEngine.command };

    const microphoneAllowed = async (): Promise<boolean | "prompted"> => {
        if (process.platform !== "darwin") {
            return true;
        }

        const status = systemPreferences.getMediaAccessStatus("microphone");

        if (status === "not-determined") {
            // The prompt held this press while the key may have come up, and the key-up is only seen from the capture window.
            return await systemPreferences.askForMediaAccess("microphone") ? "prompted" : false;
        }

        return status === "granted";
    };

    const confirmDownload = async (spec: ModelSpec): Promise<boolean> => {
        const megabytes = Math.round(spec.bytes / 1_000_000);
        const { response } = await dialog.showMessageBox({
            buttons: ["Download", "Cancel"],
            cancelId: 1,
            defaultId: 0,
            detail: `${spec.label} is ${megabytes} MB. It is kept on this computer and recognises your voice here: no audio leaves it.`,
            message: "Download the on-device speech model?",
            type: "question",
        });

        return response === 0;
    };

    const hasHelper = (): boolean => testEngine !== undefined || existsSync(helperPath());

    /** The shortcut is held only while the switch is on and the helper exists: off, other apps keep the key. */
    const syncShortcut = (): void => {
        const wanted = settings.get().enabled && hasHelper();

        if (wanted && !shortcutHeld) {
            shortcutHeld = globalShortcut.register(DICTATION_SHORTCUT, () => controller?.press());
            shortcutRefused = !shortcutHeld;

            if (shortcutRefused) {
                options.log(`dictation: could not register ${DICTATION_SHORTCUT}`);
            }
        } else if (!wanted) {
            if (shortcutHeld) {
                globalShortcut.unregister(DICTATION_SHORTCUT);
            }

            shortcutHeld = false;
            shortcutRefused = false;
        }
    };

    /** Cancels a dictation and waits (briefly) for its helper to exit: Windows will not delete a model file the helper still has open. */
    const cancelDictation = async (): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(resolve, HELPER_EXIT_WAIT_MS);
        });

        controller?.cancel();

        try {
            await Promise.race([recognizer?.exited(), timeout]);
        } finally {
            clearTimeout(timer);
        }
    };

    const settingsWindow = createSettingsWindow({
        api: createSettingsApi({
            cancelDictation,
            hasHelper,
            models,
            offered,
            onEnabledChange: syncShortcut,
            onNotice: (message) => settingsWindow.changed(message),
            resolveModel: () => chosenModel().id,
            settings,
            shortcut: DICTATION_SHORTCUT_LABEL,
            shortcutRefused: () => shortcutRefused,
        }),
        log: options.log,
    });

    const register = (): void => {
        controller = createDictationController({
            confirmDownload,
            enabled: () => settings.get().enabled,
            hasHelper,
            insert: (text) =>
                insertDictation(
                    {
                        canTakeDraft: options.canTakeDraft,
                        handOffDraft: options.handOffDraft,
                        notify,
                        writeClipboard: (value) => clipboard.writeText(value),
                    },
                    text,
                ),
            log: options.log,
            microphoneAllowed,
            model: chosenModel,
            models: {
                // A download the shortcut started shows in an open settings window too.
                download: async (spec) => {
                    const running = models.download(spec);

                    settingsWindow.changed();

                    try {
                        return await running;
                    } finally {
                        settingsWindow.changed();
                    }
                },
                ensureVerified: async (spec) => testEngine?.modelPath ?? models.ensureVerified(spec),
                isDownloading: (spec) => models.isDownloading(spec),
                status: async (spec) => testEngine === undefined ? models.status(spec) : { bytes: 0, file: spec.file, state: "present", version: spec.version },
            },
            notify,
            now: () => Date.now(),
            openWindow,
            startRecognizer: (modelPath) => {
                // The folder is ours and empty: if the helper ever wrote a file, this is where it would land.
                const started = startRecognizer({ cwd: dictationFolder, helper: helper(), language: settings.get().language, modelPath });

                recognizer = started;

                return started;
            },
        });

        const fromWindow = (handler: (event: IpcMainEvent, payload: unknown) => void) => (event: IpcMainEvent, payload: unknown) => {
            if (isFromWindow(event)) {
                handler(event, payload);
            } else {
                options.log("dictation: ignored a message from a sender that is not the capture window");
            }
        };

        ipcMain.on(
            DICTATION_CHANNEL.audio,
            fromWindow((_event, payload) => {
                const chunk = toBuffer(payload);

                if (chunk !== undefined && controller?.addAudio(chunk) === true) {
                    probe.audioBytes += chunk.length;
                }
            }),
        );
        ipcMain.on(
            DICTATION_CHANNEL.ended,
            fromWindow(() => ended?.()),
        );
        ipcMain.on(
            DICTATION_CHANNEL.failed,
            fromWindow((_event, payload) => {
                if (CAPTURE_FAILURES.includes(payload as CaptureFailure)) {
                    controller?.captureFailed(payload as CaptureFailure);
                }
            }),
        );

        (async () => {
            try {
                await mkdir(dictationFolder, { mode: 0o700, recursive: true });
                await models.sweepPartials();
            } catch (error) {
                options.log(`dictation: could not prepare its folder: ${String(error)}`);
            }
        })();

        if (!app.isPackaged) {
            Object.assign(probe, {
                begin: () => controller?.press(),
                cancel: () => controller?.cancel(),
                end: () => controller?.release(),
                openSettings: settingsWindow.open,
                useTestEngine: (replacement: { args: string[]; command: string; modelPath: string }) => {
                    testEngine = replacement;
                },
            });
        }

        settingsWindow.register();

        if (!existsSync(helperPath())) {
            options.log("dictation: the speech helper is not part of this build, so the shortcut is not registered");
        }

        syncShortcut();

        app.on("will-quit", () => {
            controller?.cancel();
            recognizer?.kill();
            globalShortcut.unregister(DICTATION_SHORTCUT);
        });
    };

    return { isWindow, openSettings: settingsWindow.open, policy, probe: app.isPackaged ? undefined : probe, register };
};
