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

import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent, WebContents, WebPreferences } from "electron";
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, session, shell, systemPreferences, Tray } from "electron";

import type { MenuCommand } from "./app-menu.js";
import { buildAppMenuTemplate } from "./app-menu.js";
import { accentHex, APPEARANCE_FILE, PAGE_IS_DARK_SCRIPT, pageThemeChangeScript, readAppearance, SHOW_FALLBACK_MS, supportsVibrancy, windowBackground, writeAppearance } from "./appearance.js";
import { createSetBadgeHandler } from "./badge.js";
import { CAPABILITIES_ARG, CHANNEL, SITE_ORIGIN_ARG } from "./channels.js";
import { registerDeviceIpc } from "./device/index.js";
import type { Dictation, DictationProbe } from "./dictation/index.js";
import { createDictation } from "./dictation/index.js";
import type { DroppedFile } from "./dropped-files.js";
import { queueDroppedFiles, readDroppedFiles } from "./dropped-files.js";
import { loginItemMenuState } from "./login-item.js";
import { createMenuDelivery } from "./menu-delivery.js";
import { recoveryPageUrl, shouldRecoverFromLoadFailure, shouldRecoverFromRendererGone } from "./recovery.js";
import type { PendingSignIn, SignInHandoff } from "./sign-in.js";
import { beginSignIn, completeSignIn, isFlowState, parseSignInCallback } from "./sign-in.js";
import { clampText, MAX_COMPOSE_CHARS, newChatUrl, parseDeepLink, SCHEME, siteOrigin } from "./site.js";
import type { TerminalController } from "./terminal/index.js";
import { registerTerminalIpc } from "./terminal/index.js";
import { threadWindowUrl } from "./thread-window.js";
import { classifyUrl, isDraftTarget, isLocalPage, isTrustedUrl } from "./trust.js";
import { clearPendingUpdate, decideUpdateOutcome, PENDING_UPDATE_FILE, readPendingUpdate, writePendingUpdate } from "./update-notice.js";
import { createDebouncer, DEFAULT_SIZE, readWindowState, restorableState, SAVE_DEBOUNCE_MS, WINDOW_STATE_FILE, writeWindowState } from "./window-state.js";

interface ShellState {
    composer?: BrowserWindow;
    /** Set while a new composer loads: presses then only flip whether it opens at its first paint. */
    composerOpening?: { wanted: boolean };
    /** Set once `registerDeviceIpc` has run: the core loaded. */
    deviceReady: boolean;
    /** Set in `start`: the tray's "Dictation settings…" opens its local window. */
    dictation?: Dictation;
    isQuitting: boolean;
    mainWindow?: BrowserWindow;
    pendingCompose?: string;
    pendingDraft?: string;
    pendingFiles?: DroppedFile[];
    pendingSignIn?: SignInHandoff;
    signInFlow?: PendingSignIn;
    terminals?: TerminalController;
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

/**
 * The site windows draw the sidebar material behind the page; the page makes its sidebar see-through only when told
 * (the `vibrancy` capability), so its main pane stays opaque.
 */
const VIBRANCY = supportsVibrancy(process.platform);
const vibrancy: BrowserWindowConstructorOptions = VIBRANCY ? { vibrancy: "sidebar", visualEffectState: "followWindow" } : {};

/**
 * Windows and Linux put the menu bar above the page's own top bar; hidden, it is one Alt press away and its accelerators
 * still work. macOS keeps its menu in the system bar.
 */
const hiddenMenuBar: BrowserWindowConstructorOptions = process.platform === "darwin" ? {} : { autoHideMenuBar: true };
// URL schemes are case-insensitive and the parser lowercases them, so the command-line filters compare case-insensitively too.
const SCHEME_PREFIX = `${SCHEME}://`;

const state: ShellState = { deviceReady: false, isQuitting: false };
const pendingDeepLinks: string[] = [];

/**
 * What the e2e suite (`e2e/shell.spec.ts`) reads through `app.evaluate`: Electron
 * has no API to list trays, so the shell reports what it created.
 */
const shellProbe: {
    device: boolean;
    dictation?: DictationProbe;
    openTerminal: (folder: string) => Promise<void>;
    /** Whether the Quick Composer window exists: it is created on its first use. */
    quickComposer: boolean;
    terminalPids: () => number[];
    /** What the shortcut and the tray item do; the e2e suite cannot press a global shortcut. */
    toggleQuickComposer: () => void;
    tray: boolean;
} = {
    device: false,
    openTerminal: async (_folder: string): Promise<void> => {},
    quickComposer: false,
    terminalPids: (): number[] => [],
    toggleQuickComposer: (): void => {},
    tray: false,
};

Object.assign(globalThis, { neoreShell: shellProbe });

const log = (message: string): void => {
    process.stderr.write(`[neore-desktop] ${message}\n`);
};

const showNotification = (title: string, body?: string): void => {
    const notification = new Notification({ body, title });

    notification.show();
};

/**
 * The call came from the TOP frame of the contents it names. A same-origin iframe inside a trusted
 * window shares the site's URL and would otherwise pass every origin check below.
 */
const isTopFrame = (event: IpcMainInvokeEvent, contents: { mainFrame: unknown } | undefined): boolean =>
    contents !== undefined && event.senderFrame != null && event.senderFrame === contents.mainFrame;

const isTrusted = (event: IpcMainInvokeEvent): boolean =>
    isTrustedUrl(origin, event.senderFrame?.url) && isTopFrame(event, event.sender);

/**
 * The hand-offs (dropped files, compose text, the sign-in code) are sent to the main window only, so
 * only the main window may take them. A thread window that drained one would keep it from the page.
 */
const isMainWindow = (event: IpcMainInvokeEvent): boolean =>
    isTrusted(event)
    && state.mainWindow !== undefined
    && event.sender.id === state.mainWindow.webContents.id
    && isTopFrame(event, state.mainWindow.webContents);

/** Only the Quick Composer's own page, from its own window: not the site, not another local page. */
const isFromComposer = (event: IpcMainInvokeEvent): boolean =>
    isLocalPage(composerPage, event.senderFrame?.url)
    && state.composer !== undefined
    && event.sender.id === state.composer.webContents.id
    && isTopFrame(event, state.composer.webContents);

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

/** Cancels a navigation that leaves the site and hands it elsewhere; answers whether it did. */
const guardNavigation = (event: { preventDefault: () => void }, url: string): boolean => {
    switch (classifyUrl(origin, url)) {
        case "artifact": {
            event.preventDefault();
            openArtifactWindow(new URL(url));

            return true;
        }
        case "external": {
            event.preventDefault();
            openWebLinkExternally(URL.parse(url) ?? undefined);

            return true;
        }
        case "oauth": {
            // Google refuses embedded webviews: cancel, and run the flow in the system browser.
            event.preventDefault();
            startBrowserSignIn();

            return true;
        }
        default: {
            // "site": an ordinary page of ours navigates in place.
            return false;
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
    const capabilities = ["notifications", "compose", "sign-in", "thread-windows", "menu-commands"];

    if (VIBRANCY) {
        capabilities.push("vibrancy");
    }

    if (hasSystemAccent()) {
        capabilities.push("system-accent");
    }

    if (isMain && state.deviceReady && existsSync(path.join(__dirname, "device-window", "device.html"))) {
        capabilities.push("device");
    }

    if (isMain) {
        shellProbe.device = capabilities.includes("device");
    }

    return capabilities;
};

/**
 * The accent colour as `#rrggbb`, or `null`. macOS and Windows always have one; Linux answers only on some desktops, and
 * an Electron without the method, or a desktop that throws, has none.
 */
const readSystemAccent = (): string | null => {
    try {
        return typeof systemPreferences.getAccentColor === "function" ? accentHex(systemPreferences.getAccentColor()) : null;
    } catch {
        return null;
    }
};

/** What macOS posts to every app when the user picks another accent (or highlight) colour. */
// eslint-disable-next-line no-secrets/no-secrets -- a macOS notification name, not a credential
const MAC_ACCENT_NOTIFICATION = "AppleColorPreferencesChangedNotification";

const hasSystemAccent = (): boolean => process.platform === "darwin" || process.platform === "win32" || readSystemAccent() !== null;

/** Every open site window (main, thread, same-origin popup): what the accent colour and menu commands are sent to. */
const siteWindows = new Set<BrowserWindow>();

/** A window that is destroyed or is showing something other than the site (the recovery page) gets nothing. */
const isShowingSite = (win: BrowserWindow): boolean => !win.isDestroyed() && isTrustedUrl(origin, win.webContents.getURL());

/**
 * Menu commands wait for the page to listen. A page that never does (an older site) gets New Chat in a window of its
 * own: loading it over the current page would cut off a reply that is still streaming there. The recovery page holds no
 * work, so New Chat loads the site over it.
 */
const menuDelivery = createMenuDelivery<BrowserWindow>({
    fallback: (win, command) => {
        if (command === "new-chat") {
            // Always a fresh window: even a page at the new-chat path may hold a draft (`/chat?prompt=…`).
            openSiteWindow(newChatUrl(origin));
        } else {
            log(`the page does not listen for menu commands; "${command}" dropped`);
        }
    },
    isShowingSite,
    offSite: async (win, command) => {
        if (command === "new-chat") {
            // The site is likely unreachable here: `did-fail-load` shows the recovery page again.
            try {
                await win.loadURL(newChatUrl(origin).href);
            } catch (error) {
                log(`could not open New Chat: ${String(error)}`);
            }
        } else {
            log(`the window shows no site page; "${command}" dropped`);
        }
    },
    send: (win, command) => win.webContents.send(CHANNEL.menuCommand, command),
});

const broadcastSystemAccent = (): void => {
    const accent = readSystemAccent();

    for (const win of siteWindows) {
        if (isShowingSite(win)) {
            win.webContents.send(CHANNEL.systemAccentColor, accent);
        }
    }
};

const appearanceFile = (): string => path.join(app.getPath("userData"), APPEARANCE_FILE);

/**
 * Filled with the page's own background until its first paint; with vibrancy, left clear so the material shows. The
 * site has a theme setting of its own, so the theme its last load showed wins over the system's.
 */
const siteBackground = (withVibrancy: boolean): string =>
    windowBackground({ dark: readAppearance(appearanceFile())?.dark ?? nativeTheme.shouldUseDarkColors, vibrancy: withVibrancy });

const saveSiteTheme = (dark: boolean): void => {
    if (readAppearance(appearanceFile())?.dark !== dark) {
        writeAppearance(appearanceFile(), { dark });
    }
};

/** The latest document of each site webContents: a watch started for an earlier one ends at its next answer. */
const siteDocuments = new WeakMap<WebContents, number>();

const nextSiteDocument = (contents: WebContents): number => {
    const next = (siteDocuments.get(contents) ?? 0) + 1;

    siteDocuments.set(contents, next);

    return next;
};

const isCurrentSiteDocument = (contents: WebContents, siteDocument: number): boolean =>
    !contents.isDestroyed() && siteDocuments.get(contents) === siteDocument && isTrustedUrl(origin, contents.getURL());

/**
 * Keeps the theme a loaded site page shows, for the next window's pre-paint fill, and follows it while the document
 * stays: each answer arms the next watch, so a toggle without a reload is kept too. One watch per document; it ends
 * when the window is destroyed, leaves the site, or commits another document. A failure is logged, never thrown.
 */
const followSiteTheme = async (contents: WebContents, siteDocument: number, script: string = PAGE_IS_DARK_SCRIPT): Promise<void> => {
    try {
        const dark: unknown = await contents.executeJavaScript(script);

        if (typeof dark !== "boolean" || !isCurrentSiteDocument(contents, siteDocument)) {
            return;
        }

        saveSiteTheme(dark);
        followSiteTheme(contents, siteDocument, pageThemeChangeScript(dark));
    } catch (error) {
        // A navigation or a closed window ends the pending watch this way: only a live document's failure is news.
        if (isCurrentSiteDocument(contents, siteDocument)) {
            log(`could not keep the page's theme: ${String(error)}`);
        }
    }
};

/** The reveal of each window that has not been shown yet. A window without an entry has been revealed. */
const pendingReveals = new WeakMap<BrowserWindow, (focus?: boolean) => void>();

/** Main windows revealed without the focus, saved maximized: they maximize at their first focus, and count as maximized. */
const maximizeAtFocus = new WeakSet<BrowserWindow>();

/** Windows hidden on purpose before their first reveal: neither the first paint nor the fallback timer shows them. */
const hiddenBeforeReveal = new WeakSet<BrowserWindow>();

const isRevealed = (win: BrowserWindow): boolean => !pendingReveals.has(win);

/** Windows not revealed yet that are loading the recovery page: they are shown once it is drawn, not empty before. */
const awaitingRecoveryDraw = new WeakSet<BrowserWindow>();

/**
 * Whether a reveal nobody asked for may take the focus: not from another window of ours. A dictation ends when its
 * window loses the focus, and `show` focuses the window it shows on Windows.
 */
const mayTakeFocus = (win: BrowserWindow): boolean => {
    const focused = BrowserWindow.getFocusedWindow();

    return focused === null || focused === win;
};

interface RevealOptions {
    /** The user asked for this window (a thread, a popup, New Chat): its reveal takes the focus like `bringForward`. */
    focusOnReveal?: boolean;
    show?: (focus: boolean) => void;
}

/**
 * Windows are created hidden and shown at their first paint, so nobody sees an empty frame. A page that never paints
 * (a hung load, a failure the recovery page replaces) is shown anyway: by the returned function, or after a timeout.
 * `show` is told whether to focus: always when asked to (`bringForward`) or when the user opened the window
 * (`focusOnReveal`), else only if no other window of ours has it.
 */
const showWhenReady = (
    win: BrowserWindow,
    { focusOnReveal = false, show = (focus) => (focus ? win.show() : win.showInactive()) }: RevealOptions = {},
): ((focus?: boolean) => void) => {
    let shown = false;
    const reveal = (focus?: boolean): void => {
        // Closed (hidden) before it was ever shown: only `bringForward` may show it now.
        if (shown || win.isDestroyed() || hiddenBeforeReveal.has(win)) {
            return;
        }

        shown = true;
        pendingReveals.delete(win);
        clearTimeout(timer);
        show(focus ?? (focusOnReveal || mayTakeFocus(win)));
    };
    // A window waiting for its recovery page has a fallback of its own, from the start of that load.
    const timer = setTimeout(() => {
        if (!awaitingRecoveryDraw.has(win)) {
            reveal();
        }
    }, SHOW_FALLBACK_MS);

    pendingReveals.set(win, reveal);
    win.on("ready-to-show", () => reveal());

    return reveal;
};

/**
 * Brings a window forward. One not revealed yet is revealed now, through its own reveal: a plain `show` would leave the
 * reveal to run again at `ready-to-show`, and on Windows and Linux its `maximize` would then resize the window and take
 * the focus a second time.
 */
const bringForward = (win: BrowserWindow): void => {
    const reveal = pendingReveals.get(win);

    if (reveal !== undefined) {
        hiddenBeforeReveal.delete(win);
        reveal(true);

        return;
    }

    if (win.isMinimized()) {
        win.restore();
    }

    win.show();
    win.focus();
};

const windowStateFile = (): string => path.join(app.getPath("userData"), WINDOW_STATE_FILE);

/**
 * Writes the main window's normal (not maximized) bounds. A failed write is logged; it never stops a close.
 * Before its reveal the window has not been maximized yet, so nothing is written: the saved state stays as it was.
 */
const saveWindowState = (win: BrowserWindow): void => {
    if (win.isDestroyed() || !isRevealed(win)) {
        return;
    }

    const { height, width, x, y } = win.getNormalBounds();

    try {
        writeWindowState(windowStateFile(), { bounds: { height, width, x, y }, maximized: win.isMaximized() || maximizeAtFocus.has(win) });
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
const guardSiteWindow = (win: BrowserWindow, reveal: (focus?: boolean) => void): void => {
    const contents = win.webContents;

    siteWindows.add(win);
    win.on("closed", () => {
        siteWindows.delete(win);
        menuDelivery.forget(win);
    });

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

    // Both come after `did-start-navigation` (`will-navigate` from Electron's navigation throttle): a navigation cancelled
    // here was counted as started, and the page that stays gets its menu commands back at once.
    contents.on("will-navigate", (event, url) => {
        if (guardNavigation(event, url)) {
            menuDelivery.navigationCancelled(win);
        }
    });
    contents.on("will-redirect", (event, url) => {
        if (guardNavigation(event, url) && event.isMainFrame) {
            menuDelivery.navigationCancelled(win);
        }
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());

    // Each committed document has to subscribe to menu commands again (an in-page route change is not a `did-navigate`).
    // From the start of a cross-document navigation the departing page gets nothing: it may unload before it acts.
    // One that never commits (cancelled, a download) ends in `did-fail-provisional-load`, and the page stays; one that
    // ends with no word at all is settled at `did-stop-loading` once nothing is loading, which also ends a load that failed
    // or was stopped.
    contents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) {
            menuDelivery.navigationStarted(win);
        }
    });
    contents.on("did-fail-provisional-load", (_event, _code, _description, _url, isMainFrame: boolean) => {
        if (isMainFrame) {
            menuDelivery.navigationAbandoned(win);
        }
    });
    contents.on("did-navigate", (_event, url: string) => {
        // A committed document ends the theme watch of the one before it.
        nextSiteDocument(contents);
        menuDelivery.navigated(win, isTrustedUrl(origin, url));
    });
    // A stop while still loading is a replaced navigation's: the newer one keeps what is held for its page.
    contents.on("did-stop-loading", () => menuDelivery.loaded(win, contents.isLoading()));

    // The fallback of the latest recovery load: a newer failure replaces the page, so it replaces the timer too.
    let recoveryFallback: ReturnType<typeof setTimeout> | undefined;

    // A site that cannot be loaded or a renderer that died leaves a blank window with no way forward: show our own page.
    const recover = async (page: string): Promise<void> => {
        // `ready-to-show` does not fire again for the recovery page; the timer covers a recovery load that never finishes.
        if (!isRevealed(win)) {
            awaitingRecoveryDraw.add(win);
            clearTimeout(recoveryFallback);
            recoveryFallback = setTimeout(() => {
                recoveryFallback = undefined;
                awaitingRecoveryDraw.delete(win);
                reveal();
            }, SHOW_FALLBACK_MS);
        }

        try {
            await contents.loadURL(page);
        } catch (error) {
            log(`could not show the recovery page: ${String(error)}`);
        }
    };

    contents.on("did-fail-load", (_event, errorCode: number, description: string, validatedUrl: string, isMainFrame: boolean) => {
        if (!shouldRecoverFromLoadFailure(errorCode, isMainFrame, validatedUrl)) {
            return;
        }

        log(`the page failed to load (${errorCode} ${description})`);
        recover(recoveryPageUrl("unreachable", newChatUrl(origin).href, `${description} (${errorCode})`));
    });
    contents.on("render-process-gone", (_event, details: { reason: string }) => {
        if (!shouldRecoverFromRendererGone(details.reason)) {
            return;
        }

        log(`the page process ended (${details.reason})`);
        recover(recoveryPageUrl("crashed", newChatUrl(origin).href, details.reason));
    });

    contents.on("did-finish-load", () => {
        if (awaitingRecoveryDraw.delete(win)) {
            clearTimeout(recoveryFallback);
            recoveryFallback = undefined;
            reveal();
        }

        // Only the site gets the strip and is asked its theme: the page is ours, and the scripts are ours too.
        if (!isTrustedUrl(origin, contents.getURL())) {
            return;
        }

        if (process.platform === "darwin") {
            contents.executeJavaScript(TITLE_BAR_SCRIPT);
        }

        followSiteTheme(contents, nextSiteDocument(contents));
    });
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
 * A site page in its own window (a thread, a same-origin popup, New Chat for a page that does not listen): no state
 * file, no tray, and closing it really closes it. Each is opened by the user, so its reveal takes the focus.
 */
const openSiteWindow = (url: URL): BrowserWindow => {
    const win = new BrowserWindow({
        backgroundColor: siteBackground(VIBRANCY),
        height: DEFAULT_SIZE.height,
        minHeight: 560,
        minWidth: 420,
        show: false,
        title: "Neore",
        ...macTitleBar,
        ...vibrancy,
        ...hiddenMenuBar,
        webPreferences: siteWebPreferences(false),
        width: DEFAULT_SIZE.width,
    });

    guardSiteWindow(win, showWhenReady(win, { focusOnReveal: true }));
    win.loadURL(url.href);

    return win;
};

/** The open window of each thread, by its URL. Asking again for a thread brings that window forward. */
const threadWindows = new Map<string, BrowserWindow>();

const openOrFocusThreadWindow = (url: URL): void => {
    const open = threadWindows.get(url.href);

    if (open !== undefined && !open.isDestroyed()) {
        bringForward(open);

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
        backgroundColor: siteBackground(false),
        height: DEFAULT_SIZE.height,
        minHeight: 560,
        minWidth: 420,
        show: false,
        title: "Neore preview",
        ...hiddenMenuBar,
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
    showWhenReady(win, { focusOnReveal: true });
    win.loadURL(url.href);
};

const createMainWindow = (): BrowserWindow => {
    // Restored only if it still lies on a connected display; otherwise the defaults, centred.
    const saved = restorableState(
        readWindowState(windowStateFile()),
        screen.getAllDisplays().map((display) => display.workArea),
    );
    const win = new BrowserWindow({
        backgroundColor: siteBackground(VIBRANCY),
        height: saved?.bounds.height ?? DEFAULT_SIZE.height,
        minHeight: 560,
        minWidth: 420,
        show: false,
        title: "Neore",
        ...macTitleBar,
        ...vibrancy,
        ...hiddenMenuBar,
        webPreferences: siteWebPreferences(true),
        width: saved?.bounds.width ?? DEFAULT_SIZE.width,
        x: saved?.bounds.x,
        y: saved?.bounds.y,
    });
    // `maximize` shows a hidden window on Windows and Linux, so it waits for the first paint too. It also activates the
    // window on Windows, so a reveal that must leave the focus where it is maximizes when the user comes to the window.
    const showMain = (focus: boolean): void => {
        if (!focus) {
            win.showInactive();

            if (saved?.maximized) {
                maximizeAtFocus.add(win);
                win.once("focus", () => {
                    if (maximizeAtFocus.delete(win)) {
                        win.maximize();
                    }
                });
            }

            return;
        }

        if (saved?.maximized) {
            win.maximize();
        }

        win.show();
    };
    const reveal = showWhenReady(win, { show: showMain });

    // Move and resize fire many times a second; one write after the last one is enough.
    const stateSaver = createDebouncer(() => saveWindowState(win), SAVE_DEBOUNCE_MS);

    win.on("move", () => stateSaver.call());
    win.on("resize", () => stateSaver.call());

    guardSiteWindow(win, reveal);

    win.on("close", (event) => {
        // Saved here too: a hide keeps the window alive, but the next launch should still start where it was left.
        stateSaver.cancel();
        saveWindowState(win);

        if (state.isQuitting || !canHideOnClose()) {
            return;
        }

        event.preventDefault();

        if (!isRevealed(win)) {
            hiddenBeforeReveal.add(win);
        }

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

    bringForward(mainWindow);
};

/**
 * A menu command goes to the site window in front. With none in front (the Quick Composer, a local window, a window on
 * the recovery page, or no window at all) the main window is brought forward and takes it, once its page listens.
 */
const sendMenuCommand = (command: MenuCommand): void => {
    const focused = BrowserWindow.getFocusedWindow();
    const target = focused !== null && siteWindows.has(focused) && isShowingSite(focused) ? focused : undefined;

    if (target === undefined) {
        focusMain();
    }

    const win = target ?? state.mainWindow;

    if (win !== undefined) {
        menuDelivery.deliver(win, command);
    }
};

const documentationUrl = (): URL => new URL("/docs", origin);

const installAppMenu = (): void => {
    Menu.setApplicationMenu(
        Menu.buildFromTemplate(
            buildAppMenuTemplate({
                appName: app.name,
                isPackaged: app.isPackaged,
                onCommand: sendMenuCommand,
                onOpenDocumentation: () => openWebLinkExternally(documentationUrl()),
                platform: process.platform,
            }),
        ),
    );
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

/** A deep link's text goes into the composer for the user to read and send. The shell never sends it. */
const handOffDraft = (text: string): void => {
    state.pendingDraft = text;
    focusMain();
    state.mainWindow?.webContents.send(CHANNEL.draft);
};

const finishBrowserSignIn = (code: string, callbackState: string): void => {
    const pending = state.signInFlow;

    // Anything can send a callback, so one whose state is not the flow's is refused without ending the flow: the real one must still arrive.
    if (pending !== undefined && !isFlowState(pending, callbackState)) {
        log("dropped a sign-in callback that does not match the sign-in in progress");

        return;
    }

    // The flow is consumed whatever the outcome, so a replayed callback cannot retry it.
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
        handOffDraft(action.text);
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
        if (state.composer !== win) {
            return;
        }

        state.composer = undefined;
        state.composerOpening = undefined;
    });

    // A page that failed to load, or whose renderer died, never paints again: it is thrown away, and the next press
    // makes a new one instead of toggling a dead window.
    const discard = (): void => {
        if (state.composer === win) {
            state.composer = undefined;
            state.composerOpening = undefined;
        }

        if (!win.isDestroyed()) {
            win.destroy();
        }
    };

    contents.on("did-fail-load", (_event, _errorCode: number, _description: string, _validatedUrl: string, isMainFrame: boolean) => {
        if (isMainFrame) {
            discard();
        }
    });
    contents.on("render-process-gone", () => discard());

    const load = async (): Promise<void> => {
        try {
            await win.loadURL(composerPage.href);
        } catch {
            discard();
        }
    };

    load();
    state.composer = win;
    shellProbe.quickComposer = true;

    return win;
};

const revealQuickComposer = (composer: BrowserWindow): void => {
    composer.center();
    composer.show();
    composer.focus();
};

/**
 * The composer is created on its first use, not at start-up, so a launch spends no renderer on it while the site
 * loads. Until its `ready-to-show` it is never shown: its page focuses the prompt on the window's `focus`, which a
 * window shown before its script ran would miss. A press while it loads opens or closes it once it is ready.
 */
const toggleQuickComposer = (): void => {
    const { composer } = state;

    if (composer === undefined) {
        const created = createQuickComposer();
        const opening = { wanted: true };

        state.composerOpening = opening;
        created.once("ready-to-show", () => {
            // A composer discarded after a failed load may still report its paint: the window is gone for good.
            if (state.composer !== created) {
                return;
            }

            if (state.composerOpening === opening) {
                state.composerOpening = undefined;
            }

            if (opening.wanted) {
                revealQuickComposer(created);
            }
        });

        return;
    }

    if (state.composerOpening !== undefined) {
        state.composerOpening.wanted = !state.composerOpening.wanted;

        return;
    }

    if (composer.isVisible()) {
        composer.hide();

        return;
    }

    revealQuickComposer(composer);
};

/** A global shortcut can be taken by another app, and Wayland has none at all, so a failure is logged, never fatal. */
const registerQuickComposerShortcut = (): void => {
    if (!globalShortcut.register(QUICK_COMPOSER_SHORTCUT, toggleQuickComposer)) {
        log(`could not register ${QUICK_COMPOSER_SHORTCUT}`);
    }
};

/** Asks for a folder, then opens a terminal in it. A refusal (no such folder, no terminal here) is logged. */
const openTerminalFromTray = async (): Promise<void> => {
    try {
        await state.terminals?.open(null);
    } catch (error) {
        log(`could not open a terminal: ${String(error)}`);
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
        { click: () => state.dictation?.openSettings(), label: "Dictation settings…" },
        {
            click: () => {
                openTerminalFromTray();
            },
            enabled: state.terminals?.availability.available === true,
            label: "Terminal…",
        },
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

        // Without a tray, closing the window quits the app and stops its agents (see `canHideOnClose`). macOS hides regardless, so it needs no notice.
        if (process.platform !== "darwin") {
            try {
                showNotification(
                    "Neore has no tray icon",
                    "Closing the window will quit Neore and stop any running agent. Your desktop needs a system tray for Neore to keep running in the background.",
                );
            } catch (noticeError) {
                // A failed notice must not abort start-up: the shortcuts, dictation and update checks still have to run.
                log(`could not show the tray notice: ${String(noticeError)}`);
            }
        }
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

    // Main window only: a thread window's bell shows the same count, but two windows publishing in turn
    // could leave an older count on the dock.
    ipcMain.handle(
        CHANNEL.setBadge,
        createSetBadgeHandler({
            isTrusted: isMainWindow,
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

    // Sent, not invoked: the page has nothing to wait for.
    ipcMain.on(CHANNEL.menuCommandsReady, (event): void => {
        if (!isTrusted(event)) {
            log("menu-commands-ready: ignored an untrusted sender");

            return;
        }

        const win = [...siteWindows].find((candidate) => !candidate.isDestroyed() && candidate.webContents === event.sender);

        if (win !== undefined) {
            menuDelivery.ready(win);
        }
    });

    // The page's last `onMenuCommand` subscriber left: its commands are held again, as for a page that has not listened.
    ipcMain.on(CHANNEL.menuCommandsUnready, (event): void => {
        if (!isTrusted(event)) {
            log("menu-commands-unready: ignored an untrusted sender");

            return;
        }

        const win = [...siteWindows].find((candidate) => !candidate.isDestroyed() && candidate.webContents === event.sender);

        if (win !== undefined) {
            menuDelivery.unready(win);
        }
    });

    ipcMain.handle(CHANNEL.getSystemAccentColor, (event): string | null => {
        if (!isTrusted(event)) {
            throw new Error("system-accent-color: untrusted sender");
        }

        return readSystemAccent();
    });

    ipcMain.handle(CHANNEL.takePendingCompose, (event): string | undefined => {
        if (!isMainWindow(event)) {
            return undefined;
        }

        const text = state.pendingCompose;

        state.pendingCompose = undefined;

        return text;
    });

    ipcMain.handle(CHANNEL.takePendingDraft, (event): string | undefined => {
        if (!isMainWindow(event)) {
            return undefined;
        }

        const text = state.pendingDraft;

        state.pendingDraft = undefined;

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

    // The terminal has no site-facing channel at all: it is opened from the device window or the tray menu.
    state.terminals = registerTerminalIpc();
    shellProbe.terminalPids = () => state.terminals?.pids() ?? [];
    shellProbe.openTerminal = (folder) => state.terminals?.open(folder) ?? Promise.reject(new Error("no terminal"));
    state.deviceReady = registerDeviceIpc({ isTrusted: isMainWindow, terminal: state.terminals });
};

const pendingUpdateFile = (): string => path.join(app.getPath("userData"), PENDING_UPDATE_FILE);

const rememberDownloadedUpdate = (version: string): void => {
    try {
        writePendingUpdate(pendingUpdateFile(), { version });
    } catch (error) {
        log(`could not record the downloaded update: ${String(error)}`);
    }
};

/**
 * A downloaded update is installed when the app quits. If this start is still on the older version, the install did not
 * happen (blocked, killed, no permission): say so once, with where to get the build by hand, instead of letting the person
 * believe they run the new one. An applied update clears the record.
 */
const noticeUnappliedUpdate = (): void => {
    try {
        const file = pendingUpdateFile();
        const outcome = decideUpdateOutcome(readPendingUpdate(file), app.getVersion());

        if (outcome.kind === "applied") {
            clearPendingUpdate(file);
        } else if (outcome.kind === "not-applied") {
            writePendingUpdate(file, { noticed: true, version: outcome.version });
            showNotification(
                "Neore was not updated",
                `Version ${outcome.version} was downloaded but ${outcome.current} is still running. Install it from github.com/anolilab/neore/releases.`,
            );
        }
    } catch (error) {
        log(`could not check the downloaded update: ${String(error)}`);
    }
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

    noticeUnappliedUpdate();

    try {
        const { autoUpdater } = await import("electron-updater");

        autoUpdater.on("update-downloaded", (info) => {
            rememberDownloadedUpdate(info.version);
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
    // Electron grants every permission unless told otherwise. Only the site gets any, and the dictation window its microphone:
    // one policy answers for both sessions (`dictation/permissions.ts`), so they cannot drift apart.
    const dictation = createDictation({
        canTakeDraft: () => state.mainWindow !== undefined && !state.mainWindow.isDestroyed() && isDraftTarget(origin, state.mainWindow.webContents.getURL()),
        handOffDraft,
        isSiteUrl: (url) => isTrustedUrl(origin, url),
        log,
        sitePermissions: ALLOWED_PERMISSIONS,
    });
    const ses = session.defaultSession;

    ses.setPermissionRequestHandler(dictation.policy.request);
    ses.setPermissionCheckHandler(dictation.policy.check);
    shellProbe.dictation = dictation.probe;
    state.dictation = dictation;

    registerIpc();
    registerSchemeInDev();
    installAppMenu();

    // `accent-color-changed` is Windows and Linux only; macOS posts a distributed notification instead.
    if (process.platform === "darwin") {
        systemPreferences.subscribeNotification(MAC_ACCENT_NOTIFICATION, broadcastSystemAccent);
    } else {
        systemPreferences.on("accent-color-changed", broadcastSystemAccent);
    }

    createMainWindow();
    createTray();
    shellProbe.toggleQuickComposer = toggleQuickComposer;
    registerQuickComposerShortcut();
    dictation.register();
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
