/**
 * Electron main process: the main window on the site, the tray, the Quick Composer,
 * system-browser sign-in, deep links, notifications and the updater.
 *
 * Every IPC handler checks its sender's URL. The site's channels accept only
 * the site's origin; the Quick Composer's accept only its own local page.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent, WebPreferences } from "electron";
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, session, shell, Tray } from "electron";

import { createSetBadgeHandler } from "./badge.js";
import { CAPABILITIES_ARG, CHANNEL, SITE_ORIGIN_ARG } from "./channels.js";
import { registerDeviceIpc } from "./device/index.js";
import type { DroppedFile } from "./dropped-files.js";
import { queueDroppedFiles, readDroppedFiles } from "./dropped-files.js";
import { loginItemMenuState } from "./login-item.js";
import type { PendingSignIn, SignInHandoff } from "./sign-in.js";
import { beginSignIn, completeSignIn, parseSignInCallback } from "./sign-in.js";
import { clampText, MAX_COMPOSE_CHARS, newChatUrl, parseDeepLink, SCHEME, siteOrigin } from "./site.js";
import { threadWindowUrl } from "./thread-window.js";
import { classifyUrl, isLocalPage, isTrustedUrl } from "./trust.js";
import { createDebouncer, DEFAULT_SIZE, readWindowState, restorableState, SAVE_DEBOUNCE_MS, WINDOW_STATE_FILE, writeWindowState } from "./window-state.js";

interface ShellState {
    composer?: BrowserWindow;
    /** Set once `registerDeviceIpc` has run: the core loaded. */
    deviceReady: boolean;
    isQuitting: boolean;
    mainWindow?: BrowserWindow;
    pendingCompose?: string;
    pendingFiles?: DroppedFile[];
    pendingSignIn?: SignInHandoff;
    signInFlow?: PendingSignIn;
    tray?: Tray;
}

const origin = siteOrigin();
const composerPage = pathToFileURL(path.join(__dirname, "quick-composer", "index.html"));
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "media", "notifications"]);
// eslint-disable-next-line no-secrets/no-secrets -- a keyboard accelerator, not a credential
const QUICK_COMPOSER_SHORTCUT = "CommandOrControl+Shift+Space";

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
    // Full-height elements shrink by the same amount; without this the page is taller than the window.
    const style = document.createElement("style");
    style.textContent = \`html { padding-top: ${TITLE_BAR_HEIGHT}px !important; }
.h-dvh, .h-screen, .h-svh { height: calc(100dvh - ${TITLE_BAR_HEIGHT}px) !important; }
.min-h-svh, .min-h-screen { min-height: calc(100dvh - ${TITLE_BAR_HEIGHT}px) !important; }\`;
    document.head.append(style);
})();`;
// URL schemes are case-insensitive and the parser lowercases them, so the command-line filters compare case-insensitively too.
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

/**
 * The hand-offs (dropped files, compose text, the sign-in code) are sent to the main window only, so
 * only the main window may take them. A thread window that drained one would keep it from the page.
 */
const isMainWindow = (event: IpcMainInvokeEvent): boolean =>
    isTrusted(event) && state.mainWindow !== undefined && event.sender.id === state.mainWindow.webContents.id;

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

/** The system browser gets web links only: never `file:`, a custom scheme or anything else. */
const openWebLinkExternally = (url: URL | undefined): void => {
    if (url?.protocol === "http:" || url?.protocol === "https:") {
        openInBrowser(url.href);
    }
};

const guardNavigation = (event: { preventDefault: () => void }, url: string): void => {
    switch (classifyUrl(origin, url)) {
        case "artifact": {
            event.preventDefault();
            openArtifactWindow(new URL(url));

            break;
        }
        case "external": {
            event.preventDefault();
            openWebLinkExternally(URL.parse(url) ?? undefined);

            break;
        }
        case "oauth": {
            // Google refuses embedded webviews: cancel, and run the flow in the system browser.
            event.preventDefault();
            startBrowserSignIn();

            break;
        }
        default: {
            // "site": an ordinary page of ours navigates in place.
            break;
        }
    }
};

/**
 * What this build can do, as the site must read it. `device` is listed only when the
 * core loaded AND the local device page is in the build; otherwise the relay would
 * answer "unavailable" to every call. Only the main window advertises `device`: a thread window
 * that claimed a call would return its result to a window that may close.
 */
const siteCapabilities = (isMain: boolean): string[] => {
    const capabilities = ["notifications", "compose", "sign-in", "thread-windows"];

    if (isMain && state.deviceReady && existsSync(path.join(__dirname, "device-window", "device.html"))) {
        capabilities.push("device");
    }

    if (isMain) {
        shellProbe.device = capabilities.includes("device");
    }

    return capabilities;
};

const windowStateFile = (): string => path.join(app.getPath("userData"), WINDOW_STATE_FILE);

/** Writes the main window's normal (not maximized) bounds. A failed write is logged; it never stops a close. */
const saveWindowState = (win: BrowserWindow): void => {
    if (win.isDestroyed()) {
        return;
    }

    const { height, width, x, y } = win.getNormalBounds();

    try {
        writeWindowState(windowStateFile(), { bounds: { height, width, x, y }, maximized: win.isMaximized() });
    } catch (error) {
        log(`could not save the window state: ${String(error)}`);
    }
};

/** What every site window gets: the site preload, isolated and sandboxed. `isMain` decides the capabilities it advertises. */
const siteWebPreferences = (isMain: boolean): WebPreferences => {
    return {
        additionalArguments: [`${SITE_ORIGIN_ARG}${origin.origin}`, `${CAPABILITIES_ARG}${siteCapabilities(isMain).join(",")}`],
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "preload.cjs"),
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
    };
};

/** Popups, navigation and webviews of a site window: same-origin stays in the app, sign-in goes to the system browser, the rest is refused. */
const guardSiteWindow = (win: BrowserWindow): void => {
    const contents = win.webContents;

    contents.setWindowOpenHandler(({ url }) => {
        switch (classifyUrl(origin, url)) {
            case "artifact": {
                openArtifactWindow(new URL(url));

                break;
            }
            case "external": {
                openWebLinkExternally(URL.parse(url) ?? undefined);

                break;
            }
            case "oauth": {
                startBrowserSignIn();

                break;
            }
            default: {
                // "site": a same-origin popup gets its own window: the opener keeps its page, its draft and its state.
                openSiteWindow(new URL(url));

                break;
            }
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
                contents.executeJavaScript(TITLE_BAR_SCRIPT);
            }
        });
    }
};

/**
 * Without a tray nothing hides, so the last site window to close ends the app. The Quick Composer is
 * hidden rather than closed, so it does not count, and the quit is decided here rather than by `window-all-closed`.
 */
const quitWhenNoSiteWindow = (): void => {
    if (state.isQuitting || canHideOnClose()) {
        return;
    }

    if (BrowserWindow.getAllWindows().every((win) => win === state.composer)) {
        app.quit();
    }
};

/**
 * A site page in its own window (a thread, or a same-origin popup): no state file, no tray, and
 * closing it really closes it.
 */
const openSiteWindow = (url: URL): BrowserWindow => {
    const win = new BrowserWindow({
        height: DEFAULT_SIZE.height,
        minHeight: 560,
        minWidth: 420,
        title: "Neore",
        ...macTitleBar,
        webPreferences: siteWebPreferences(false),
        width: DEFAULT_SIZE.width,
    });

    guardSiteWindow(win);
    win.loadURL(url.href);

    return win;
};

/** The open window of each thread, by its URL. Asking again for a thread brings that window forward. */
const threadWindows = new Map<string, BrowserWindow>();

const openOrFocusThreadWindow = (url: URL): void => {
    const open = threadWindows.get(url.href);

    if (open !== undefined && !open.isDestroyed()) {
        if (open.isMinimized()) {
            open.restore();
        }

        open.show();
        open.focus();

        return;
    }

    const win = openSiteWindow(url);

    threadWindows.set(url.href, win);
    win.on("closed", () => {
        // Only this window's own entry: a window opened after it may already hold the URL.
        if (threadWindows.get(url.href) === win) {
            threadWindows.delete(url.href);
        }
    });
};

/**
 * The canvas artifact preview: model-written HTML, on its own page. It gets no preload, so it never has the
 * bridge; a link it opens leaves for the system browser. Its URL carries the whole artifact, which is longer
 * than Windows passes to the system browser, so the page cannot be handed over that way.
 */
const openArtifactWindow = (url: URL): void => {
    const win = new BrowserWindow({
        height: DEFAULT_SIZE.height,
        minHeight: 560,
        minWidth: 420,
        title: "Neore preview",
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            webviewTag: false,
        },
        width: DEFAULT_SIZE.width,
    });
    const contents = win.webContents;

    contents.setWindowOpenHandler(({ url: target }) => {
        openWebLinkExternally(URL.parse(target) ?? undefined);

        return { action: "deny" };
    });
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    win.loadURL(url.href);
};

const createMainWindow = (): BrowserWindow => {
    // Restored only if it still lies on a connected display; otherwise the defaults, centred.
    const saved = restorableState(
        readWindowState(windowStateFile()),
        screen.getAllDisplays().map((display) => display.workArea),
    );
    const win = new BrowserWindow({
        height: saved?.bounds.height ?? DEFAULT_SIZE.height,
        minHeight: 560,
        minWidth: 420,
        title: "Neore",
        ...macTitleBar,
        webPreferences: siteWebPreferences(true),
        width: saved?.bounds.width ?? DEFAULT_SIZE.width,
        x: saved?.bounds.x,
        y: saved?.bounds.y,
    });

    if (saved?.maximized) {
        win.maximize();
    }

    // Move and resize fire many times a second; one write after the last one is enough.
    const stateSaver = createDebouncer(() => saveWindowState(win), SAVE_DEBOUNCE_MS);

    win.on("move", () => stateSaver.call());
    win.on("resize", () => stateSaver.call());

    guardSiteWindow(win);

    win.on("close", (event) => {
        // Saved here too: a hide keeps the window alive, but the next launch should still start where it was left.
        stateSaver.cancel();
        saveWindowState(win);

        if (state.isQuitting || !canHideOnClose()) {
            return;
        }

        event.preventDefault();
        win.hide();
    });

    win.on("closed", () => {
        stateSaver.cancel();
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

/** Like `handOffCompose`: the files are held for `takePendingFiles`, and the event only tells the page to ask. */
const handOffFiles = (files: DroppedFile[]): void => {
    if (files.length === 0) {
        return;
    }

    state.pendingFiles = queueDroppedFiles(state.pendingFiles, files);
    focusMain();
    state.mainWindow?.webContents.send(CHANNEL.files);
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

const buildTrayMenu = (): Menu => {
    const login = loginItemMenuState({
        isPackaged: app.isPackaged,
        openAtLogin: app.isPackaged && app.getLoginItemSettings().openAtLogin,
        platform: process.platform,
    });

    return Menu.buildFromTemplate([
        { click: () => focusMain(), label: "Open Neore" },
        { accelerator: QUICK_COMPOSER_SHORTCUT, click: () => toggleQuickComposer(), label: "Quick Composer" },
        { click: () => startBrowserSignIn(), label: "Sign in with browser" },
        { type: "separator" },
        { checked: login.checked, click: () => toggleLoginItem(), enabled: login.enabled, label: "Start at login", type: "checkbox" },
        { type: "separator" },
        { click: () => app.quit(), label: "Quit Neore" },
    ]);
};

/** Flips the OS login item, then rebuilds the menu so the check mark follows what the OS now says. */
const toggleLoginItem = (): void => {
    app.setLoginItemSettings({ openAtLogin: !app.getLoginItemSettings().openAtLogin });
    state.tray?.setContextMenu(buildTrayMenu());
};

const createTray = (): void => {
    try {
        const icon = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ height: 18 });
        const tray = new Tray(icon);

        tray.setToolTip("Neore");
        tray.setContextMenu(buildTrayMenu());
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

    ipcMain.handle(
        CHANNEL.setBadge,
        createSetBadgeHandler({
            isTrusted,
            platform: process.platform,
            setBadgeCount: (count) => app.setBadgeCount(count),
        }),
    );

    ipcMain.handle(CHANNEL.openThreadWindow, (event, threadId: unknown): void => {
        if (!isTrusted(event)) {
            throw new Error("open-thread-window: untrusted sender");
        }

        const url = threadWindowUrl(origin, threadId);

        if (url === undefined) {
            throw new Error("open-thread-window: invalid thread id");
        }

        openOrFocusThreadWindow(url);
    });

    ipcMain.handle(CHANNEL.takePendingCompose, (event): string | undefined => {
        if (!isMainWindow(event)) {
            return undefined;
        }

        const text = state.pendingCompose;

        state.pendingCompose = undefined;

        return text;
    });

    ipcMain.handle(CHANNEL.takePendingFiles, (event): DroppedFile[] => {
        if (!isMainWindow(event)) {
            return [];
        }

        const files = state.pendingFiles ?? [];

        state.pendingFiles = undefined;

        return files;
    });

    ipcMain.handle(CHANNEL.startBrowserSignIn, (event): void => {
        if (!isTrusted(event)) {
            throw new Error("sign-in: untrusted sender");
        }

        startBrowserSignIn();
    });

    ipcMain.handle(CHANNEL.takePendingSignIn, (event): SignInHandoff | undefined => {
        if (!isMainWindow(event)) {
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

    state.deviceReady = registerDeviceIpc({ isTrusted: isMainWindow });
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

/** Registers the scheme at runtime where no installer does: a dev run, on Linux and Windows. */
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
        if (argument.toLowerCase().startsWith(SCHEME_PREFIX)) {
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

// Every window is covered (the main window, thread and preview windows, the device window): whichever closes last ends the app.
app.on("browser-window-created", (_event, win) => {
    win.on("closed", quitWhenNoSiteWindow);
});

// macOS delivers deep links through this event, possibly before `ready`.
app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
});

/** Each task starts after the one before it has finished, so work queued in order also finishes in order. */
const createInOrderRunner = () => {
    let previous: Promise<void> = Promise.resolve();

    return (task: () => Promise<void>): void => {
        previous = (async () => {
            await previous;
            await task();
        })();
    };
};

const runDropInOrder = createInOrderRunner();

/** Waits for `ready`, because the window a drop may open needs the app ready. A failure is logged; it never stops the next drop. */
const takeDroppedFile = async (filePath: string): Promise<void> => {
    try {
        await app.whenReady();
        handOffFiles(await readDroppedFiles([filePath]));
    } catch (error) {
        log(`could not take a dropped file: ${String(error)}`);
    }
};

// macOS: a file dragged onto the dock icon. Each drop is read in turn, so a file that reads faster cannot overtake an earlier one.
app.on("open-file", (event, filePath) => {
    event.preventDefault();
    runDropInOrder(() => takeDroppedFile(filePath));
});

app.on("second-instance", (_event, argv) => {
    for (const argument of argv) {
        if (argument.toLowerCase().startsWith(SCHEME_PREFIX)) {
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
