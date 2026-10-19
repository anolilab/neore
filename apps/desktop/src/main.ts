/**
 * Electron main process. Port of `apps/native/src-tauri/src/{lib.rs,desktop.rs,sign_in.rs}`:
 * the main window on the site, the tray, the Quick Composer, system-browser
 * sign-in, deep links, notifications and the updater.
 *
 * Every IPC handler checks its sender's URL. The site's channels accept only
 * the site's origin; the Quick Composer's accept only its own local page.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent } from "electron";
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from "electron";

import { CAPABILITIES_ARG, CHANNEL, SITE_ORIGIN_ARG } from "./channels.js";
import { registerDeviceIpc } from "./device/index.js";
import type { PendingSignIn, SignInHandoff } from "./sign-in.js";
import { beginSignIn, completeSignIn, isBlockedOauthUrl, parseSignInCallback } from "./sign-in.js";
import { clampText, isSameOrigin, MAX_COMPOSE_CHARS, newChatUrl, parseDeepLink, SCHEME, siteOrigin } from "./site.js";
import { isLocalPage, isTrustedUrl } from "./trust.js";

interface ShellState {
    composer?: BrowserWindow;
    /** Set once `registerDeviceIpc` has run: the core loaded. */
    deviceReady: boolean;
    isQuitting: boolean;
    mainWindow?: BrowserWindow;
    pendingCompose?: string;
    pendingSignIn?: SignInHandoff;
    signInFlow?: PendingSignIn;
    tray?: Tray;
}

const origin = siteOrigin();
const composerPage = pathToFileURL(path.join(__dirname, "quick-composer", "index.html"));
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "media", "notifications"]);
const QUICK_COMPOSER_SHORTCUT = "CommandOrControl+Shift+Space";
const WEB_LINK = /^(?:https?|mailto):/u;

/**
 * macOS draws the page under a hidden title bar: the traffic lights sit inside the
 * page's top-left corner, and a strip at the top stays draggable. The page's own
 * top bar starts below the strip, so its controls are not covered.
 */
const TITLE_BAR_HEIGHT = 28;
const macTitleBar: BrowserWindowConstructorOptions = process.platform === "darwin" ? { titleBarStyle: "hidden", trafficLightPosition: { x: 16, y: 12 } } : {};
const TITLE_BAR_SCRIPT = `(() => {
    if (document.getElementById("neore-titlebar")) {
        return;
    }
    const strip = document.createElement("div");
    strip.id = "neore-titlebar";
    strip.setAttribute("aria-hidden", "true");
    Object.assign(strip.style, {
        position: "fixed", top: "0", left: "0", right: "0", height: "${TITLE_BAR_HEIGHT}px",
        zIndex: "2147483000", webkitAppRegion: "drag",
    });
    document.body.append(strip);
    // Content starts below the title bar, so the traffic lights never sit on the page's own controls.
    document.documentElement.style.paddingTop = "${TITLE_BAR_HEIGHT}px";
})();`;
const SCHEME_PREFIX = `${SCHEME}://`;

const state: ShellState = { deviceReady: false, isQuitting: false };
const pendingDeepLinks: string[] = [];

/**
 * What the e2e suite (`e2e/shell.spec.ts`) reads through `app.evaluate`: Electron
 * has no API to list trays, so the shell reports what it created.
 */
const shellProbe = { device: false, quickComposer: false, tray: false };

Object.assign(globalThis, { neoreShell: shellProbe });

const log = (message: string): void => {
    process.stderr.write(`[neore-desktop] ${message}\n`);
};

const showNotification = (title: string, body?: string): void => {
    const notification = new Notification({ body, title });

    notification.show();
};

const isTrusted = (event: IpcMainInvokeEvent): boolean => isTrustedUrl(origin, event.senderFrame?.url);

/** Only the Quick Composer's own page, from its own window: not the site, not another local page. */
const isFromComposer = (event: IpcMainInvokeEvent): boolean =>
    isLocalPage(composerPage, event.senderFrame?.url) && state.composer !== undefined && event.sender.id === state.composer.webContents.id;

/** Closing hides the window instead, so the tray and the shortcut keep the app alive. A desktop with no tray support closes for real. */
const canHideOnClose = (): boolean => process.platform === "darwin" || state.tray !== undefined;

const openInBrowser = async (url: string): Promise<void> => {
    try {
        await shell.openExternal(url);
    } catch (error) {
        log(`could not open the browser: ${String(error)}`);
    }
};

/** Opens the grant page in the SYSTEM browser. A new call replaces any earlier flow. */
const startBrowserSignIn = (): void => {
    const { pending, url } = beginSignIn(origin);

    state.signInFlow = pending;
    openInBrowser(url.href);
};

const guardNavigation = (event: { preventDefault: () => void }, url: string): void => {
    if (!isBlockedOauthUrl(url)) {
        return;
    }

    // Google refuses embedded webviews: cancel, and run the flow in the system browser.
    event.preventDefault();
    startBrowserSignIn();
};

/**
 * What this build can do, as the site must read it. `device` is listed only when the
 * core loaded AND the local device page is in the build; otherwise the relay would
 * answer "unavailable" to every call.
 */
const siteCapabilities = (): string[] => {
    const capabilities = ["notifications", "compose", "sign-in"];

    if (state.deviceReady && existsSync(path.join(__dirname, "device-window", "device.html"))) {
        capabilities.push("device");
    }

    shellProbe.device = capabilities.includes("device");

    return capabilities;
};

const createMainWindow = (): BrowserWindow => {
    const win = new BrowserWindow({
        height: 820,
        minHeight: 560,
        minWidth: 420,
        title: "Neore",
        ...macTitleBar,
        webPreferences: {
            additionalArguments: [`${SITE_ORIGIN_ARG}${origin.origin}`, `${CAPABILITIES_ARG}${siteCapabilities().join(",")}`],
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, "preload.cjs"),
            sandbox: true,
            webSecurity: true,
            webviewTag: false,
        },
        width: 1200,
    });

    const contents = win.webContents;

    contents.setWindowOpenHandler(({ url }) => {
        const parsed = URL.parse(url) ?? undefined;

        if (isBlockedOauthUrl(url)) {
            startBrowserSignIn();
        } else if (parsed !== undefined && isSameOrigin(origin, parsed)) {
            // Same-origin popups stay in the app; other web links go to the system browser.
            contents.loadURL(url);
        } else if (WEB_LINK.test(url)) {
            openInBrowser(url);
        }

        return { action: "deny" };
    });

    contents.on("will-navigate", (event, url) => guardNavigation(event, url));
    contents.on("will-redirect", (event, url) => guardNavigation(event, url));
    contents.on("will-attach-webview", (event) => event.preventDefault());

    if (process.platform === "darwin") {
        contents.on("did-finish-load", () => {
            // Only the site gets the strip: the page is ours, and the script is ours too.
            if (isTrustedUrl(origin, contents.getURL())) {
                void contents.executeJavaScript(TITLE_BAR_SCRIPT);
            }
        });
    }

    win.on("close", (event) => {
        if (state.isQuitting || !canHideOnClose()) {
            return;
        }

        event.preventDefault();
        win.hide();
    });

    win.on("closed", () => {
        state.mainWindow = undefined;
    });

    win.loadURL(newChatUrl(origin).href);
    state.mainWindow = win;

    return win;
};

const focusMain = (): void => {
    const { mainWindow } = state;

    if (mainWindow === undefined) {
        createMainWindow();

        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }

    mainWindow.show();
    mainWindow.focus();
};

/** The text is handed over through `takePendingCompose`; the event only tells the page to ask. */
const handOffCompose = (text: string): void => {
    state.pendingCompose = text;
    focusMain();
    state.mainWindow?.webContents.send(CHANNEL.compose);
};

const finishBrowserSignIn = (code: string, callbackState: string): void => {
    // The flow is consumed whatever the outcome, so a replayed callback cannot retry it.
    const pending = state.signInFlow;

    state.signInFlow = undefined;

    try {
        state.pendingSignIn = completeSignIn(pending, code, callbackState);
    } catch (error) {
        // The message names the reason only; the code itself is never logged.
        log(`dropped a sign-in callback: ${error instanceof Error ? error.message : "unknown reason"}`);

        return;
    }

    focusMain();
    state.mainWindow?.webContents.send(CHANNEL.signIn);
};

const handleDeepLink = (raw: string): void => {
    if (!app.isReady() || state.mainWindow === undefined) {
        pendingDeepLinks.push(raw);

        return;
    }

    const link = URL.parse(raw) ?? undefined;

    if (link === undefined) {
        log("ignored a malformed deep link");

        return;
    }

    const callback = parseSignInCallback(link);

    if (callback !== undefined) {
        finishBrowserSignIn(callback.code, callback.state);

        return;
    }

    const action = parseDeepLink(origin, link);

    // Never log the URL: an `auth` link that failed the shape check still carries a code.
    if (action === undefined) {
        log("ignored a deep link");

        return;
    }

    if (action.kind === "compose") {
        handOffCompose(action.text);
    } else if (action.kind === "open") {
        state.mainWindow.loadURL(action.url.href);
        focusMain();
    } else {
        focusMain();
    }
};

const createQuickComposer = (): BrowserWindow => {
    const win = new BrowserWindow({
        alwaysOnTop: true,
        frame: false,
        height: 168,
        resizable: false,
        show: false,
        skipTaskbar: true,
        title: "Quick Composer",
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, "quick-composer", "preload.cjs"),
            sandbox: true,
            webSecurity: true,
            webviewTag: false,
        },
        width: 620,
    });

    const contents = win.webContents;

    // The composer's page never navigates, so any navigation (a dropped link, a popup) is refused.
    contents.setWindowOpenHandler(() => {
        return { action: "deny" };
    });
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());

    win.on("blur", () => win.hide());
    win.on("close", (event) => {
        if (state.isQuitting) {
            return;
        }

        event.preventDefault();
        win.hide();
    });
    win.on("closed", () => {
        state.composer = undefined;
    });

    win.loadURL(composerPage.href);
    state.composer = win;
    shellProbe.quickComposer = true;

    return win;
};

const toggleQuickComposer = (): void => {
    const { composer } = state;

    if (composer === undefined) {
        return;
    }

    if (composer.isVisible()) {
        composer.hide();

        return;
    }

    composer.center();
    composer.show();
    composer.focus();
};

/** A global shortcut can be taken by another app, and Wayland has none at all, so a failure is logged, never fatal. */
const registerQuickComposerShortcut = (): void => {
    if (!globalShortcut.register(QUICK_COMPOSER_SHORTCUT, toggleQuickComposer)) {
        log(`could not register ${QUICK_COMPOSER_SHORTCUT}`);
    }
};

const createTray = (): void => {
    try {
        const icon = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ height: 18 });
        const tray = new Tray(icon);

        tray.setToolTip("Neore");
        tray.setContextMenu(
            Menu.buildFromTemplate([
                { click: () => focusMain(), label: "Open Neore" },
                { accelerator: QUICK_COMPOSER_SHORTCUT, click: () => toggleQuickComposer(), label: "Quick Composer" },
                { click: () => startBrowserSignIn(), label: "Sign in with browser" },
                { type: "separator" },
                { click: () => app.quit(), label: "Quit Neore" },
            ]),
        );
        tray.on("click", () => focusMain());

        state.tray = tray;
        shellProbe.tray = true;
    } catch (error) {
        log(`could not create the tray: ${String(error)}`);
    }
};

const registerIpc = (): void => {
    ipcMain.handle(CHANNEL.notify, (event, payload: unknown) => {
        if (!isTrusted(event)) {
            throw new Error("notify: untrusted sender");
        }

        const { body, title } = (payload ?? {}) as { body?: unknown; title?: unknown };

        if (typeof title !== "string") {
            throw new TypeError("notify: title is required");
        }

        const clampedTitle = clampText(title, 120);

        if (clampedTitle === "") {
            throw new Error("notify: title is required");
        }

        // The page decides what is worth a notification; this only suppresses it while the user is looking.
        const { mainWindow } = state;

        if (mainWindow?.isFocused() && mainWindow.isVisible()) {
            return;
        }

        const clampedBody = typeof body === "string" ? clampText(body, 300) : "";

        showNotification(clampedTitle, clampedBody || undefined);
    });

    ipcMain.handle(CHANNEL.takePendingCompose, (event): string | undefined => {
        if (!isTrusted(event)) {
            return undefined;
        }

        const text = state.pendingCompose;

        state.pendingCompose = undefined;

        return text;
    });

    ipcMain.handle(CHANNEL.startBrowserSignIn, (event): void => {
        if (!isTrusted(event)) {
            throw new Error("sign-in: untrusted sender");
        }

        startBrowserSignIn();
    });

    ipcMain.handle(CHANNEL.takePendingSignIn, (event): SignInHandoff | undefined => {
        if (!isTrusted(event)) {
            return undefined;
        }

        const handoff = state.pendingSignIn;

        state.pendingSignIn = undefined;

        return handoff;
    });

    ipcMain.handle(CHANNEL.quickCompose, (event, payload: unknown): void => {
        if (!isFromComposer(event)) {
            throw new Error("quick-compose: untrusted sender");
        }

        const text = typeof payload === "string" ? clampText(payload, MAX_COMPOSE_CHARS) : "";

        if (text === "") {
            throw new Error("nothing to send");
        }

        state.composer?.hide();
        handOffCompose(text);
    });

    ipcMain.handle(CHANNEL.closeQuickComposer, (event): void => {
        if (!isFromComposer(event)) {
            throw new Error("quick-compose: untrusted sender");
        }

        state.composer?.hide();
    });

    state.deviceReady = registerDeviceIpc({ isTrusted });
};

/**
 * Checks GitHub Releases on start and downloads a found update; it is applied on
 * the next launch. Dev builds never check: they have no release to compare with.
 * The feed is the `publish` block in `electron-builder.yml`.
 */
const checkForUpdates = async (): Promise<void> => {
    if (!app.isPackaged) {
        return;
    }

    try {
        const { autoUpdater } = await import("electron-updater");

        autoUpdater.on("update-downloaded", (info) => {
            // Applied on the next launch; a restart mid-reply would lose the stream.
            showNotification("Neore update installed", `Version ${info.version} will be used after you restart Neore.`);
        });
        autoUpdater.on("error", (error) => {
            log(`update failed: ${error.message}`);
        });

        await autoUpdater.checkForUpdates();
    } catch (error) {
        log(`update check failed: ${String(error)}`);
    }
};

/** Registers the scheme at runtime where no installer does: a dev run, on Linux and Windows (Tauri does the same). */
const registerSchemeInDev = (): void => {
    if (app.isPackaged || (process.platform !== "linux" && process.platform !== "win32")) {
        return;
    }

    app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1] ?? ".")]);
};

const drainPendingDeepLinks = (): void => {
    const links = [...pendingDeepLinks];

    pendingDeepLinks.length = 0;

    for (const link of links) {
        handleDeepLink(link);
    }
};

const start = (): void => {
    // Electron grants every permission unless told otherwise. Only the site gets any.
    const ses = session.defaultSession;

    ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
        callback(ALLOWED_PERMISSIONS.has(permission) && isTrustedUrl(origin, details.requestingUrl));
    });
    ses.setPermissionCheckHandler(
        (_webContents, permission, requestingOrigin) => ALLOWED_PERMISSIONS.has(permission) && isTrustedUrl(origin, requestingOrigin),
    );

    registerIpc();
    registerSchemeInDev();
    createMainWindow();
    createQuickComposer();
    createTray();
    registerQuickComposerShortcut();
    checkForUpdates();

    // Windows and Linux pass a deep link on the command line at first launch.
    for (const argument of process.argv) {
        if (argument.startsWith(SCHEME_PREFIX)) {
            pendingDeepLinks.push(argument);
        }
    }

    drainPendingDeepLinks();
};

// A second launch forwards its deep link here and exits (`second-instance`).
if (!app.requestSingleInstanceLock()) {
    app.quit();
}

app.on("ready", start);

// macOS delivers deep links through this event, possibly before `ready`.
app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
});

app.on("second-instance", (_event, argv) => {
    for (const argument of argv) {
        if (argument.startsWith(SCHEME_PREFIX)) {
            handleDeepLink(argument);
        }
    }

    focusMain();
});

app.on("before-quit", () => {
    state.isQuitting = true;
});

app.on("activate", () => {
    if (state.mainWindow === undefined) {
        createMainWindow();
    } else {
        focusMain();
    }
});

app.on("window-all-closed", () => {
    // Closing hides the window, so this only fires when nothing can hide: quit.
    if (process.platform !== "darwin" && state.tray === undefined) {
        app.quit();
    }
});
