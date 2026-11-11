/**
 * Exercises the main process through its real handlers, with `electron` mocked.
 * The real-binary suite (`e2e/`) covers the same paths against Electron 45; these
 * cases pin the security decisions and the handoffs. Mocking `electron` is the
 * only way to reach IPC handlers without launching it.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SHOW_FALLBACK_MS } from "./appearance.js";
import { CAPABILITIES_ARG } from "./channels.js";
import { DICTATION_SHORTCUT } from "./dictation/hold.js";
import { MENU_READY_GRACE_MS } from "./menu-delivery.js";
import { WINDOW_STATE_FILE } from "./window-state.js";

type Listener = (event: { preventDefault: () => void }, url: string) => void;

interface FakeWindow {
    /** `maximize` and `show`, in the order the main process called them. */
    calls: string[];
    focused: boolean;
    handlers: Map<string, Listener>;
    id: number;
    loaded: string[];
    maximized: boolean;
    options: Record<string, unknown>;
    sent: string[];
    shown: boolean;
    webContents: {
        getURL: () => string;
        handlers: Map<string, Listener>;
        id: number;
        loadURL: (url: string) => Promise<void>;
        mainFrame: { url: string };
        on: (event: string, listener: Listener) => void;
        send: (channel: string, payload?: unknown) => void;
        setWindowOpenHandler: (listener: (details: { url: string }) => { action: string }) => void;
        windowOpen?: (details: { url: string }) => { action: string };
    };
}

interface Fake {
    /** `systemPreferences.on("accent-color-changed")`: Windows and Linux. */
    accentChangedListeners: (() => void)[];
    accentColor: string;
    appHandlers: Map<string, (...args: unknown[]) => void>;
    applicationMenu?: { template: { label?: string; role?: string; submenu?: { click?: () => void; label?: string }[] }[] };
    focusedWindow: FakeWindow | null;
    ipc: Map<string, (event: unknown, payload?: unknown) => unknown>;
    /** `systemPreferences.subscribeNotification`: macOS distributed notifications, by name. */
    macNotifications: { callback: () => void; name: string | null }[];
    notificationFails: boolean;
    notifications: { body?: string; title: string }[];
    opened: string[];
    payloads: { channel: string; payload: unknown; window: number }[];
    permissionCheck?: (wc: unknown, permission: string, requestingOrigin: string, details?: unknown) => boolean;
    permissionRequest?: (wc: unknown, permission: string, callback: (isAllowed: boolean) => void, details: { mediaTypes?: string[]; requestingUrl: string }) => void;
    shortcuts: Map<string, () => void>;
    /** `nativeTheme.on(...)`, by event name. */
    themeListeners: string[];
    trayFails: boolean;
    trays: number;
    userData: string;
    windows: FakeWindow[];
}

vi.mock("electron", () => {
    const fakeElectron: Fake = {
        accentChangedListeners: [],
        accentColor: "0a84ffff",
        appHandlers: new Map(),
        focusedWindow: null,
        ipc: new Map(),
        macNotifications: [],
        notificationFails: false,
        notifications: [],
        opened: [],
        payloads: [],
        shortcuts: new Map(),
        themeListeners: [],
        trayFails: false,
        trays: 0,
        userData: path.join(os.tmpdir(), "neore-desktop-test"),
        windows: [],
    };

    /** A window record: its state and the methods `main.ts` calls, all on one object. */
    const createWindow = (options: Record<string, unknown> = {}): FakeWindow => {
        const id = fakeElectron.windows.length + 1;
        const handlers = new Map<string, Listener>();
        const webHandlers = new Map<string, Listener>();
        const window = {
            calls: [] as string[],
            center: () => {},
            focus: () => {},
            focused: true,
            getNormalBounds: () => {
                return { height: 820, width: 1200, x: 0, y: 0 };
            },
            handlers,
            hide: () => {
                window.shown = false;
            },
            id,
            isDestroyed: () => false,
            isFocused: () => window.focused,
            isMaximized: () => window.maximized,
            isMinimized: () => false,
            isVisible: () => window.shown,
            loaded: [] as string[],
            loadURL: (url: string) => {
                window.loaded.push(url);

                return Promise.resolve();
            },
            maximize: () => {
                window.calls.push("maximize");
                window.maximized = true;
            },
            maximized: false,
            on: (event: string, listener: Listener) => {
                handlers.set(event, listener);

                return window;
            },
            options,
            restore: () => {},
            sent: [] as string[],
            show: () => {
                window.calls.push("show");
                window.shown = true;
            },
            shown: false,
            webContents: {
                getURL: () => window.loaded.at(-1) ?? "",
                handlers: webHandlers,
                id,
                loadURL: (url: string) => {
                    window.loaded.push(url);

                    return Promise.resolve();
                },
                mainFrame: { url: "" },
                on: (event: string, listener: Listener) => {
                    webHandlers.set(event, listener);
                },
                send: (channel: string, payload?: unknown) => {
                    window.sent.push(channel);
                    fakeElectron.payloads.push({ channel, payload, window: id });
                },
                setWindowOpenHandler: (listener: (details: { url: string }) => { action: string }) => {
                    window.webContents.windowOpen = listener;
                },
                windowOpen: undefined as FakeWindow["webContents"]["windowOpen"],
            },
        };

        fakeElectron.windows.push(window as unknown as FakeWindow);

        return window as unknown as FakeWindow;
    };

    // Plain functions, not `vi.fn`: `main.ts` calls them with `new`, and they return the record.
    const FakeBrowserWindow = function FakeBrowserWindow(options: Record<string, unknown>) {
        return createWindow(options);
    };

    FakeBrowserWindow.getFocusedWindow = (): FakeWindow | null => fakeElectron.focusedWindow;

    const FakeTray = function FakeTray() {
        if (fakeElectron.trayFails) {
            throw new Error("no system tray is available");
        }

        fakeElectron.trays += 1;

        return { on: () => {}, setContextMenu: () => {}, setToolTip: () => {} };
    };

    const FakeNotification = function FakeNotification(options: { body?: string; title: string }) {
        if (fakeElectron.notificationFails) {
            throw new Error("notifications are unavailable");
        }

        fakeElectron.notifications.push(options);

        return { show: () => {} };
    };

    return {
        app: {
            getPath: () => fakeElectron.userData,
            getVersion: () => "0.0.0-test",
            isPackaged: false,
            isReady: () => true,
            name: "Neore",
            on: (event: string, listener: (...args: unknown[]) => void) => fakeElectron.appHandlers.set(event, listener),
            quit: () => {},
            requestSingleInstanceLock: () => true,
            setAsDefaultProtocolClient: () => true,
        },
        BrowserWindow: FakeBrowserWindow,
        fakeElectron,
        globalShortcut: {
            register: (accelerator: string, listener: () => void) => {
                fakeElectron.shortcuts.set(accelerator, listener);

                return true;
            },
        },
        ipcMain: {
            handle: (channel: string, listener: (event: unknown, payload?: unknown) => unknown) => fakeElectron.ipc.set(channel, listener),
            on: (channel: string, listener: (event: unknown, payload?: unknown) => unknown) => fakeElectron.ipc.set(channel, listener),
        },
        Menu: {
            buildFromTemplate: (template: unknown) => {
                return { template };
            },
            setApplicationMenu: (menu: Fake["applicationMenu"]) => {
                fakeElectron.applicationMenu = menu;
            },
        },
        nativeImage: {
            createFromPath: () => {
                return {
                    resize: () => {
                        return {};
                    },
                };
            },
        },
        nativeTheme: {
            on: (event: string) => {
                fakeElectron.themeListeners.push(event);
            },
            shouldUseDarkColors: true,
        },
        Notification: FakeNotification,
        screen: {
            getAllDisplays: () => [{ workArea: { height: 1080, width: 1920, x: 0, y: 0 } }],
        },
        session: {
            defaultSession: {
                setPermissionCheckHandler: (listener: Fake["permissionCheck"]) => {
                    fakeElectron.permissionCheck = listener;
                },
                setPermissionRequestHandler: (listener: Fake["permissionRequest"]) => {
                    fakeElectron.permissionRequest = listener;
                },
            },
        },
        shell: {
            openExternal: async (url: string) => {
                fakeElectron.opened.push(url);
            },
        },
        systemPreferences: {
            getAccentColor: () => fakeElectron.accentColor,
            on: (event: string, listener: () => void) => {
                if (event === "accent-color-changed") {
                    fakeElectron.accentChangedListeners.push(listener);
                }
            },
            subscribeNotification: (name: string | null, callback: () => void) => {
                fakeElectron.macNotifications.push({ callback, name });

                return fakeElectron.macNotifications.length;
            },
        },
        Tray: FakeTray,
    };
});

const fakeHandle: { state?: Fake } = {};

/** The mocked module's state, bound in `beforeAll`. */
const fake = (): Fake => fakeHandle.state as Fake;

const SITE = "http://localhost:5173";
const COMPOSER_SHORTCUT = "CommandOrControl+Shift+Space";
const WORDS = "x".repeat(400);
const SAFE_TOKEN_PATTERN = /^[\w-]{43}$/u;
const SITE_HTML_PATTERN = /^file:\/\/.*quick-composer\/index\.html$/u;
const TITLE_200 = "t".repeat(200);
const BLANK = " ".repeat(3);
const sender = (url: string) => {
    const mainFrame = { url };

    return { sender: { id: -1, mainFrame }, senderFrame: mainFrame };
};
/** A sender whose frame is on `url` and is the top frame of `window`. */
const topFrameOf = (window: FakeWindow, url: string) => {
    Object.assign(window.webContents.mainFrame, { url });

    return { sender: window.webContents, senderFrame: window.webContents.mainFrame };
};
/** The main window is the only window the hand-offs are sent to, so only its frame may take them. */
const siteSender = () => topFrameOf(mainWindow(), `${SITE}/chat`);
const mainWindow = (): FakeWindow => fake().windows[0];
const composer = (): FakeWindow => fake().windows[1];

/** The composer's own sender: its window's webContents, on its own file URL. */
const composerSender = () => topFrameOf(composer(), composer().loaded[0]);

const guardOf = (window: FakeWindow, event: string) => window.webContents.handlers.get(event);
const takeSignIn = () => fake().ipc.get("neore:take-pending-sign-in")?.(siteSender());

beforeAll(async () => {
    fakeHandle.state = ((await import("electron")) as unknown as { fakeElectron: Fake }).fakeElectron;

    await import("./main.js");

    // The `ready` event runs the start-up (windows, tray, IPC) once.
    fake().appHandlers.get("ready")?.();
});

describe("main window", () => {
    it("loads the chat page of the site", () => {
        expect(mainWindow().loaded).toContain(`${SITE}/chat`);
    });

    it("shows the recovery page when the site cannot load or its renderer dies, and ignores a cancelled load", () => {
        const failed = guardOf(mainWindow(), "did-fail-load") as unknown as (event: unknown, code: number, text: string, url: string, isMainFrame: boolean) => void;
        const gone = guardOf(mainWindow(), "render-process-gone") as unknown as (event: unknown, details: { reason: string }) => void;
        const recoveryPages = () => mainWindow().loaded.filter((url) => url.startsWith("data:text/html"));

        failed({}, -3, "ERR_ABORTED", `${SITE}/chat`, true);
        failed({}, -105, "ERR_NAME_NOT_RESOLVED", `${SITE}/chat`, false);
        gone({}, { reason: "clean-exit" });
        expect(recoveryPages()).toHaveLength(0);

        failed({}, -105, "ERR_NAME_NOT_RESOLVED", `${SITE}/chat`, true);
        expect(recoveryPages()).toHaveLength(1);
        expect(decodeURIComponent(recoveryPages()[0] ?? "")).toContain("Neore could not start");

        gone({}, { reason: "crashed" });
        expect(recoveryPages()).toHaveLength(2);
        expect(decodeURIComponent(recoveryPages()[1] ?? "")).toContain("Neore stopped responding");
    });

    it("hands a popup to another origin to the system browser and opens no window", async () => {
        const result = mainWindow().webContents.windowOpen?.({ url: "https://example.org/x" });

        expect(result).toStrictEqual({ action: "deny" });
        await vi.waitFor(() => expect(fake().opened).toStrictEqual(["https://example.org/x"]));
        // The main window and the (hidden) Quick Composer; nothing else.
        expect(fake().windows).toHaveLength(2);
    });

    it("opens a same-origin popup in its own window and leaves the main window on its page", () => {
        const result = mainWindow().webContents.windowOpen?.({ url: `${SITE}/chat/thread-1` });

        expect(result).toStrictEqual({ action: "deny" });
        expect(mainWindow().loaded).not.toContain(`${SITE}/chat/thread-1`);
        expect(fake().windows.at(-1)?.loaded).toContain(`${SITE}/chat/thread-1`);
    });

    it("opens the artifact preview on a page of its own, never in a site window", () => {
        const result = mainWindow().webContents.windowOpen?.({ url: `${SITE}/artifact-preview#abc` });

        expect(result).toStrictEqual({ action: "deny" });
        expect(fake().windows.at(-1)?.loaded).toContain(`${SITE}/artifact-preview#abc`);
        expect(mainWindow().loaded).not.toContain(`${SITE}/artifact-preview#abc`);
    });

    it("cancels Google sign-in inside the window, with or without a redirect", () => {
        for (const kind of ["will-navigate", "will-redirect"]) {
            let isPrevented = false;

            guardOf(mainWindow(), kind)?.(
                {
                    preventDefault: () => {
                        isPrevented = true;
                    },
                },
                "https://accounts.google.com/o/oauth2",
            );
            expect(isPrevented, kind).toBe(true);
        }
    });

    it("keeps same-site navigation in the window and sends other web links to the system browser", () => {
        const isNavigationPrevented = (url: string): boolean => {
            let isPrevented = false;

            guardOf(mainWindow(), "will-navigate")?.(
                {
                    preventDefault: () => {
                        isPrevented = true;
                    },
                },
                url,
            );

            return isPrevented;
        };

        expect(isNavigationPrevented(`${SITE}/chat/thread-2`)).toBe(false);
        expect(isNavigationPrevented("https://example.org/")).toBe(true);
        expect(isNavigationPrevented("file:///etc/passwd")).toBe(true);
        expect(fake().opened).toContain("https://example.org/");
        expect(fake().opened.every((url) => url.startsWith("http"))).toBe(true);
    });
});

describe("tray and Quick Composer", () => {
    it("creates the tray, and a hidden composer on its own local page", () => {
        expect(fake().trays).toBe(1);
        expect(composer().loaded).toHaveLength(1);
        expect(composer().loaded[0]).toMatch(SITE_HTML_PATTERN);
        expect(composer().shown).toBe(false);
        expect(fake().shortcuts.has(COMPOSER_SHORTCUT)).toBe(true);
    });

    it("toggles the composer with the global shortcut", () => {
        const toggle = fake().shortcuts.get(COMPOSER_SHORTCUT);

        toggle?.();
        expect(composer().shown).toBe(true);
        toggle?.();
        expect(composer().shown).toBe(false);
    });

    it("hands a composed text to the main window once, and hides the composer", () => {
        composer().shown = true;

        const quickCompose = fake().ipc.get("neore:quick-compose");

        expect(quickCompose?.(composerSender(), "  draft a plan  ")).toBeUndefined();
        expect(composer().shown).toBe(false);
        expect(mainWindow().sent).toContain("neore:compose");
        expect(fake().ipc.get("neore:take-pending-compose")?.(siteSender())).toBe("draft a plan");
    });

    it("refuses quick-compose from the site, from another local page, and from an empty text", () => {
        const quickCompose = fake().ipc.get("neore:quick-compose");
        const otherPage = topFrameOf(composer(), "file:///elsewhere/index.html");

        expect(() => quickCompose?.(siteSender(), "hi")).toThrow("untrusted");
        expect(() => quickCompose?.(otherPage, "hi")).toThrow("untrusted");
        expect(() => quickCompose?.(composerSender(), BLANK)).toThrow("nothing to send");
    });

    it("closes the composer for its own page, and refuses the site", () => {
        const close = fake().ipc.get("neore:close-quick-composer");

        expect(() => close?.(siteSender())).toThrow("untrusted");

        composer().shown = true;
        close?.(composerSender());
        expect(composer().shown).toBe(false);
    });

    it("keeps the composer's page out of the site's channels", () => {
        const notify = fake().ipc.get("neore:notify");

        expect(() => notify?.(composerSender(), { title: "hi" })).toThrow("untrusted");
    });
});

describe("permissions", () => {
    it("grants notifications to the site only", () => {
        const decide = (permission: string, requestingUrl: string) => {
            let isAllowed: boolean | undefined;

            fake().permissionRequest?.(
                {},
                permission,
                (value) => {
                    isAllowed = value;
                },
                { requestingUrl },
            );

            return isAllowed;
        };

        expect(decide("notifications", `${SITE}/chat`)).toBe(true);
        expect(decide("notifications", "https://example.org/")).toBe(false);
        expect(decide("geolocation", `${SITE}/chat`)).toBe(false);
        expect(fake().permissionCheck?.({}, "media", SITE)).toBe(true);
        expect(fake().permissionCheck?.({}, "media", "https://example.org")).toBe(false);
    });
});

describe("the microphone", () => {
    const askForAudio = (webContents: unknown, requestingUrl: string) => {
        let isAllowed: boolean | undefined;

        fake().permissionRequest?.(webContents, "media", (value) => {
            isAllowed = value;
        }, { mediaTypes: ["audio"], requestingUrl });

        return isAllowed;
    };

    it.each([
        ["the dictation window's page", "file:///app/dist/dictation-window/dictation.html"],
        ["the Quick Composer", "file:///app/dist/quick-composer/index.html"],
        ["the device window", "file:///app/dist/device-window/device.html"],
        ["a foreign origin", "https://example.org/"],
    ])("is refused to %s in the default session", (_name, url) => {
        expect(askForAudio({ id: 99 }, url)).toBe(false);
        expect(fake().permissionCheck?.({ id: 99 }, "media", "file:///", { mediaType: "audio", requestingUrl: url })).toBe(false);
    });

    it("is still granted to the site", () => {
        expect(askForAudio({ id: 99 }, `${SITE}/chat`)).toBe(true);
    });

    it("starts no dictation window or shortcut while the switch in settings is off, which is the default", () => {
        expect(fake().shortcuts.has(DICTATION_SHORTCUT)).toBe(false);
        expect(fake().windows.every((win) => win.loaded.every((url) => !url.includes("dictation")))).toBe(true);
    });

    describe("the dictation settings channels", () => {
        const CHANNELS = ["get", "update", "download", "remove"].map((name) => `neore:dictation-settings:${name}`);

        it("exist, and answer neither the site nor any other window", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch");
            const senders = [
                siteSender(),
                composerSender(),
                sender("file:///app/dist/dictation-settings-window/settings.html"),
                sender(`${SITE}/dictation-settings-window/settings.html`),
            ];

            const calls = CHANNELS.flatMap((channel) =>
                senders.map(async (caller) => {
                    expect(fake().ipc.has(channel)).toBe(true);

                    return fake().ipc.get(channel)?.(caller, { enabled: true, id: "small" });
                }),
            );

            await Promise.all(calls.map(async (call) => expect(call).rejects.toThrow("not the settings window")));

            expect(fetchSpy).not.toHaveBeenCalled();
            fetchSpy.mockRestore();
        });
    });
});

describe("IPC", () => {
    it("refuses notify from an untrusted sender", () => {
        const notify = fake().ipc.get("neore:notify");

        expect(() => notify?.(sender("https://example.org/"), { title: "hi" })).toThrow("untrusted");
    });

    it("refuses a notification without a title, and clamps the title", () => {
        const notify = fake().ipc.get("neore:notify");

        expect(() => notify?.(siteSender(), { title: BLANK })).toThrow("title");
        notify?.(siteSender(), { body: WORDS, title: TITLE_200 });
        // Window is focused in the fake, so nothing is shown.
        expect(fake().notifications).toHaveLength(0);
    });

    it("shows a notification when the window is not focused, clamped", () => {
        const notify = fake().ipc.get("neore:notify");

        mainWindow().focused = false;
        notify?.(siteSender(), { body: WORDS, title: TITLE_200 });
        mainWindow().focused = true;

        expect(fake().notifications.at(-1)).toStrictEqual({ body: "x".repeat(300), title: "t".repeat(120) });
    });

    it("hands a deep-linked text to the page as a draft, once, and only to the site", () => {
        const sentBefore = mainWindow().sent.length;

        fake().appHandlers.get("second-instance")?.({}, ["neore", "neore://new?text=hello%20there"]);

        const take = fake().ipc.get("neore:take-pending-draft");

        expect(take?.(sender("https://example.org/"))).toBeUndefined();
        expect(take?.(siteSender())).toBe("hello there");
        expect(take?.(siteSender())).toBeUndefined();
        expect(mainWindow().sent.slice(sentBefore)).toStrictEqual(["neore:draft"]);
    });

    it("accepts a deep link whose scheme is written in capitals", () => {
        fake().appHandlers.get("second-instance")?.({}, ["NEORE://new?text=hello"]);

        expect(fake().ipc.get("neore:take-pending-draft")?.(siteSender())).toBe("hello");
    });

    it("refuses a same-origin subframe of the main window, and a call with no sender frame", () => {
        fake().appHandlers.get("second-instance")?.({}, ["neore://new?text=hello"]);

        const subframe = { ...siteSender(), senderFrame: { url: `${SITE}/chat` } };
        const noFrame = { ...siteSender(), senderFrame: null };

        expect(fake().ipc.get("neore:take-pending-draft")?.(subframe)).toBeUndefined();
        expect(fake().ipc.get("neore:take-pending-draft")?.(noFrame)).toBeUndefined();
        expect(() => fake().ipc.get("neore:notify")?.(subframe, { title: "hi" })).toThrow("untrusted");
        expect(() => fake().ipc.get("neore:notify")?.(noFrame, { title: "hi" })).toThrow("untrusted");
        expect(fake().ipc.get("neore:take-pending-draft")?.(siteSender())).toBe("hello");
    });

    it("refuses a hand-off to a thread window, which is a site page but not the main window", () => {
        fake().ipc.get("neore:open-thread-window")?.(siteSender(), "thread-1");

        const threadWindow = fake().windows.at(-1);
        const threadSender = topFrameOf(threadWindow as FakeWindow, `${SITE}/chat/thread-1`);

        fake().appHandlers.get("second-instance")?.({}, ["neore://new?text=hello"]);

        expect(fake().ipc.get("neore:take-pending-draft")?.(threadSender)).toBeUndefined();
        expect(fake().ipc.get("neore:take-pending-draft")?.(siteSender())).toBe("hello");
    });

    it("brings an open thread's window forward instead of opening a copy", () => {
        const openThread = fake().ipc.get("neore:open-thread-window");

        openThread?.(siteSender(), "thread-2");
        const opened = fake().windows.length;

        openThread?.(siteSender(), "thread-2");

        expect(fake().windows).toHaveLength(opened);
    });
});

describe("look and application menu", () => {
    /** A committed main-frame navigation of `win` to `url`, as Electron reports it. */
    const navigate = (win: FakeWindow, url: string): void => {
        win.webContents.loadURL(url);
        guardOf(win, "did-navigate")?.({ preventDefault: () => {} }, url);
    };
    /** The page subscribed to menu commands (`onMenuCommand`), which the preload reports from its top frame. */
    const listening = (win: FakeWindow): unknown => fake().ipc.get("neore:menu-commands-ready")?.(topFrameOf(win, win.webContents.getURL()));
    const stoppedLoading = (win: FakeWindow): void => guardOf(win, "did-stop-loading")?.({ preventDefault: () => {} }, "");
    /** The page's last `onMenuCommand` subscriber left, reported from its top frame. */
    const stoppedListening = (win: FakeWindow): unknown => fake().ipc.get("neore:menu-commands-unready")?.(topFrameOf(win, win.webContents.getURL()));
    /** A main-frame navigation of `win` started, not committed yet: `did-start-navigation` as Electron 45 reports it. */
    const startNavigation = (win: FakeWindow, url: string, details: { isMainFrame?: boolean; isSameDocument?: boolean } = {}): void =>
        (guardOf(win, "did-start-navigation") as unknown as (details: object) => void)({
            frame: null,
            isMainFrame: details.isMainFrame ?? true,
            isSameDocument: details.isSameDocument ?? false,
            preventDefault: () => {},
            url,
        });
    /** The main window back on the site, its page listening: an earlier case left the recovery page in it. */
    const onSite = (): FakeWindow => {
        navigate(mainWindow(), `${SITE}/chat`);
        listening(mainWindow());

        return mainWindow();
    };
    /** Settings… sits in the app menu on macOS and in File elsewhere. */
    const menuItem = (label: string) =>
        fake()
            .applicationMenu
            ?.template
            .flatMap((entry) => entry.submenu ?? [])
            .find((item) => item.label === label);
    const menuPayloads = () => fake().payloads.filter((sent) => sent.channel === "neore:menu-command");

    it("creates the site windows hidden, on the dark background, and shows one at its first paint", () => {
        fake().ipc.get("neore:open-thread-window")?.(siteSender(), "thread-ready");

        const win = fake().windows.at(-1) as FakeWindow;

        expect(mainWindow().options).toMatchObject({ backgroundColor: "#212121", show: false });
        expect(win.options).toMatchObject({ backgroundColor: "#212121", show: false });
        expect(win.shown).toBe(false);
        (win.handlers.get("ready-to-show") as unknown as () => void)();
        expect(win.shown).toBe(true);
    });

    it("shows a thread window that never paints once its load fails", () => {
        fake().ipc.get("neore:open-thread-window")?.(siteSender(), "thread-paint");

        const win = fake().windows.at(-1) as FakeWindow;
        const failed = guardOf(win, "did-fail-load") as unknown as (event: unknown, code: number, text: string, url: string, isMainFrame: boolean) => void;

        expect(win.options).toMatchObject({ show: false });
        expect(win.shown).toBe(false);
        failed({}, -105, "ERR_NAME_NOT_RESOLVED", `${SITE}/chat/thread-paint`, true);
        expect(win.shown).toBe(true);
    });

    it("answers the accent colour as #rrggbb to the site only", () => {
        const get = fake().ipc.get("neore:get-system-accent-color");

        expect(get?.(siteSender())).toBe("#0a84ff");
        expect(() => get?.(sender("https://example.org/"))).toThrow("untrusted");
    });

    it("installs an application menu whose New Chat and Settings reach the site window in front", () => {
        const win = onSite();

        fake().payloads.length = 0;
        fake().focusedWindow = win;
        menuItem("New Chat")?.click?.();
        fake().focusedWindow = composer();
        menuItem("Settings…")?.click?.();
        fake().focusedWindow = null;

        expect(fake().payloads).toStrictEqual([
            { channel: "neore:menu-command", payload: "new-chat", window: win.id },
            { channel: "neore:menu-command", payload: "settings", window: win.id },
        ]);
    });

    it("sends a menu command to the main window when the focused thread window shows the recovery page", () => {
        const main = onSite();

        fake().ipc.get("neore:open-thread-window")?.(siteSender(), "thread-recovery");

        const thread = fake().windows.at(-1) as FakeWindow;

        navigate(thread, `${SITE}/chat/thread-recovery`);
        listening(thread);
        navigate(thread, "data:text/html,recovery");
        fake().payloads.length = 0;
        fake().focusedWindow = thread;
        menuItem("New Chat")?.click?.();
        fake().focusedWindow = null;

        expect(fake().payloads).toStrictEqual([{ channel: "neore:menu-command", payload: "new-chat", window: main.id }]);
    });

    it("holds menu commands until the page listens, then sends each once", () => {
        const win = mainWindow();

        navigate(win, `${SITE}/chat`);
        fake().payloads.length = 0;
        menuItem("New Chat")?.click?.();
        menuItem("New Chat")?.click?.();
        menuItem("Settings…")?.click?.();
        expect(menuPayloads()).toStrictEqual([]);

        listening(win);
        expect(menuPayloads()).toStrictEqual([
            { channel: "neore:menu-command", payload: "new-chat", window: win.id },
            { channel: "neore:menu-command", payload: "settings", window: win.id },
        ]);
    });

    it("takes the readiness only from the top frame of a site window", () => {
        const win = mainWindow();
        const ready = fake().ipc.get("neore:menu-commands-ready");

        navigate(win, `${SITE}/chat`);
        fake().payloads.length = 0;
        menuItem("New Chat")?.click?.();
        ready?.({ sender: win.webContents, senderFrame: { url: `${SITE}/chat` } });
        ready?.(topFrameOf(win, "https://example.org/"));
        ready?.(composerSender());
        expect(menuPayloads()).toStrictEqual([]);

        listening(win);
        expect(menuPayloads()).toStrictEqual([{ channel: "neore:menu-command", payload: "new-chat", window: win.id }]);
    });

    it("drops held commands when the window turns to the recovery page", () => {
        const win = mainWindow();

        navigate(win, `${SITE}/chat`);
        fake().payloads.length = 0;
        menuItem("New Chat")?.click?.();
        navigate(win, "data:text/html,recovery");
        navigate(win, `${SITE}/chat`);
        listening(win);

        expect(menuPayloads()).toStrictEqual([]);
    });

    it("holds a command chosen between a navigation's start and its commit for the new page, whatever the old page says", () => {
        const win = onSite();

        fake().payloads.length = 0;
        startNavigation(win, `${SITE}/chat/thread-2`);
        menuItem("New Chat")?.click?.();
        // The departing document still answers to the window's top frame until the commit.
        listening(win);
        expect(menuPayloads()).toStrictEqual([]);

        navigate(win, `${SITE}/chat/thread-2`);
        expect(menuPayloads()).toStrictEqual([]);

        listening(win);
        expect(menuPayloads()).toStrictEqual([{ channel: "neore:menu-command", payload: "new-chat", window: win.id }]);
    });

    it("keeps sending to the page through a subframe's or an in-page navigation, and through one that never commits", () => {
        const win = onSite();
        const abandoned = guardOf(win, "did-fail-provisional-load") as unknown as (event: unknown, code: number, text: string, url: string, isMainFrame: boolean) => void;

        fake().payloads.length = 0;
        startNavigation(win, `${SITE}/embed`, { isMainFrame: false });
        startNavigation(win, `${SITE}/chat/thread-3`, { isSameDocument: true });
        menuItem("New Chat")?.click?.();
        expect(menuPayloads()).toHaveLength(1);

        startNavigation(win, `${SITE}/download.zip`);
        menuItem("Settings…")?.click?.();
        expect(menuPayloads()).toHaveLength(1);

        abandoned({}, -3, "ERR_ABORTED", `${SITE}/download.zip`, true);
        expect(menuPayloads()).toStrictEqual([
            { channel: "neore:menu-command", payload: "new-chat", window: win.id },
            { channel: "neore:menu-command", payload: "settings", window: win.id },
        ]);
    });

    it("sends the commands held during a link click the shell cancelled to the page that stayed, once", () => {
        const win = onSite();
        const abandoned = guardOf(win, "did-fail-provisional-load") as unknown as (event: unknown, code: number, text: string, url: string, isMainFrame: boolean) => void;

        fake().payloads.length = 0;
        startNavigation(win, "https://example.org/");
        menuItem("New Chat")?.click?.();
        expect(menuPayloads()).toStrictEqual([]);

        guardOf(win, "will-navigate")?.({ preventDefault: () => {} }, "https://example.org/");
        expect(menuPayloads()).toStrictEqual([{ channel: "neore:menu-command", payload: "new-chat", window: win.id }]);

        // Its own failure, when Electron reports it, changes nothing.
        abandoned({}, -3, "ERR_ABORTED", "https://example.org/", true);
        stoppedLoading(win);
        menuItem("Settings…")?.click?.();
        expect(menuPayloads()).toStrictEqual([
            { channel: "neore:menu-command", payload: "new-chat", window: win.id },
            { channel: "neore:menu-command", payload: "settings", window: win.id },
        ]);
    });

    it("sends the commands held during a navigation that stopped loading without a commit to the page that stayed", () => {
        const win = onSite();

        fake().payloads.length = 0;
        startNavigation(win, `${SITE}/export.csv`);
        menuItem("Settings…")?.click?.();
        expect(menuPayloads()).toStrictEqual([]);

        stoppedLoading(win);
        menuItem("New Chat")?.click?.();
        expect(menuPayloads()).toStrictEqual([
            { channel: "neore:menu-command", payload: "settings", window: win.id },
            { channel: "neore:menu-command", payload: "new-chat", window: win.id },
        ]);
    });

    it("holds commands once the page stops listening, until it listens again, and only on its own word", () => {
        const win = onSite();
        const unready = fake().ipc.get("neore:menu-commands-unready");

        unready?.(topFrameOf(win, "https://example.org/"));
        unready?.(composerSender());
        fake().payloads.length = 0;
        menuItem("Settings…")?.click?.();
        expect(menuPayloads()).toHaveLength(1);

        stoppedListening(win);
        menuItem("New Chat")?.click?.();
        expect(menuPayloads()).toHaveLength(1);

        listening(win);
        expect(menuPayloads()).toStrictEqual([
            { channel: "neore:menu-command", payload: "settings", window: win.id },
            { channel: "neore:menu-command", payload: "new-chat", window: win.id },
        ]);
    });

    describe("a page that never listens", () => {
        afterEach(() => {
            vi.useRealTimers();
            onSite();
        });

        it("gets New Chat in a new window once its grace period ends, never over its own page, and Settings is dropped", () => {
            vi.useFakeTimers();

            const win = mainWindow();
            const windowCount = fake().windows.length;

            navigate(win, `${SITE}/chat/thread-1`);
            stoppedLoading(win);
            fake().payloads.length = 0;
            menuItem("New Chat")?.click?.();

            vi.advanceTimersByTime(MENU_READY_GRACE_MS - 1);
            expect(fake().windows).toHaveLength(windowCount);
            vi.advanceTimersByTime(1);
            // A reply may still be streaming on thread-1: that page is left alone.
            expect(win.loaded.at(-1)).toBe(`${SITE}/chat/thread-1`);
            expect(fake().windows).toHaveLength(windowCount + 1);
            expect(fake().windows.at(-1)?.loaded.at(-1)).toBe(`${SITE}/chat`);

            vi.advanceTimersByTime(MENU_READY_GRACE_MS);
            menuItem("Settings…")?.click?.();

            expect(win.loaded.at(-1)).toBe(`${SITE}/chat/thread-1`);
            expect(menuPayloads()).toStrictEqual([]);
        });

        it("gets New Chat in a fresh window even when the page is at the new-chat path with a linked draft", () => {
            vi.useFakeTimers();

            const win = mainWindow();
            const windowCount = fake().windows.length;

            navigate(win, `${SITE}/chat?prompt=draft`);
            stoppedLoading(win);
            vi.advanceTimersByTime(MENU_READY_GRACE_MS);
            menuItem("New Chat")?.click?.();

            expect(fake().windows).toHaveLength(windowCount + 1);
            expect(fake().windows.at(-1)?.loaded.at(-1)).toBe(`${SITE}/chat`);
            expect(win.loaded.at(-1)).toBe(`${SITE}/chat?prompt=draft`);
        });

        it("falls back once the grace period ends for a loaded page that stopped listening", () => {
            vi.useFakeTimers();

            const win = mainWindow();
            const windowCount = fake().windows.length;

            navigate(win, `${SITE}/chat/thread-1`);
            stoppedLoading(win);
            listening(win);
            stoppedListening(win);
            menuItem("New Chat")?.click?.();
            vi.advanceTimersByTime(MENU_READY_GRACE_MS - 1);
            expect(fake().windows).toHaveLength(windowCount);

            vi.advanceTimersByTime(1);
            expect(fake().windows).toHaveLength(windowCount + 1);
            expect(win.loaded.at(-1)).toBe(`${SITE}/chat/thread-1`);
        });

        it("gets the command itself when it starts listening within the grace period", () => {
            vi.useFakeTimers();

            const win = mainWindow();

            navigate(win, `${SITE}/chat/thread-1`);
            stoppedLoading(win);
            fake().payloads.length = 0;
            menuItem("New Chat")?.click?.();
            vi.advanceTimersByTime(MENU_READY_GRACE_MS - 1);
            listening(win);
            vi.advanceTimersByTime(MENU_READY_GRACE_MS);

            expect(win.loaded.at(-1)).toBe(`${SITE}/chat/thread-1`);
            expect(menuPayloads()).toStrictEqual([{ channel: "neore:menu-command", payload: "new-chat", window: win.id }]);
        });
    });

    it("sends neither a menu command nor the accent colour to a main window showing the recovery page", () => {
        navigate(mainWindow(), "data:text/html,recovery");
        fake().payloads.length = 0;
        fake().focusedWindow = mainWindow();
        menuItem("New Chat")?.click?.();
        fake().focusedWindow = null;
        menuItem("Settings…")?.click?.();
        fake().accentChangedListeners.forEach((listener) => listener());

        expect(fake().payloads.filter((sent) => sent.window === mainWindow().id)).toStrictEqual([]);
        onSite();
    });

    describe("the show fallback", () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it("shows a window that never paints after SHOW_FALLBACK_MS, and not again at a late first paint", () => {
            vi.useFakeTimers();
            fake().ipc.get("neore:open-thread-window")?.(siteSender(), "thread-hung");

            const win = fake().windows.at(-1) as FakeWindow;

            vi.advanceTimersByTime(SHOW_FALLBACK_MS - 1);
            expect(win.shown).toBe(false);
            vi.advanceTimersByTime(1);
            expect(win.calls).toStrictEqual(["show"]);

            (win.handlers.get("ready-to-show") as unknown as () => void)();
            expect(win.calls).toStrictEqual(["show"]);
        });
    });

    it("reveals a thread window asked for again before its first paint once, through its reveal", () => {
        const openThread = fake().ipc.get("neore:open-thread-window");

        openThread?.(siteSender(), "thread-early");

        const win = fake().windows.at(-1) as FakeWindow;

        expect(win.shown).toBe(false);
        openThread?.(siteSender(), "thread-early");
        expect(win.calls).toStrictEqual(["show"]);

        (win.handlers.get("ready-to-show") as unknown as () => void)();
        expect(win.calls).toStrictEqual(["show"]);
    });

    it("opens the docs in the system browser from Help", () => {
        fake()
            .applicationMenu
            ?.template
            .find((entry) => entry.role === "help")
            ?.submenu?.[0]
            ?.click?.();

        expect(fake().opened.at(-1)).toBe(`${SITE}/docs`);
    });
});

describe("browser sign-in", () => {
    /** Starts the flow the way the window does: Google's page is requested and cancelled. */
    const startFlow = (): URL => {
        const before = fake().opened.length;

        guardOf(mainWindow(), "will-navigate")?.(
            {
                preventDefault: () => {},
            },
            "https://accounts.google.com/o/oauth2",
        );
        expect(fake().opened).toHaveLength(before + 1);

        return new URL(fake().opened.at(-1) ?? "");
    };

    it("opens the grant page in the system browser with a PKCE challenge", () => {
        const url = startFlow();

        expect(url.origin).toBe(SITE);
        expect(url.pathname).toBe("/auth/extension");
        expect(url.searchParams.get("client")).toBe("native");
        expect(url.searchParams.get("redirect_uri")).toBe("neore://auth/callback");
        expect(url.searchParams.get("code_challenge")).toMatch(SAFE_TOKEN_PATTERN);
    });

    it("hands the code and verifier to the site, once, when the callback matches the flow", () => {
        const url = startFlow();
        const state = url.searchParams.get("state") ?? "";
        const code = "c".repeat(43);

        fake().appHandlers.get("second-instance")?.({}, [`neore://auth/callback?code=${code}&state=${state}`]);

        const handoff = takeSignIn() as { code: string; codeVerifier: string; redirectUri: string };

        expect(handoff.code).toBe(code);
        expect(handoff.redirectUri).toBe("neore://auth/callback");
        // The verifier must be the one whose challenge the browser was given.
        expect(createHash("sha256").update(handoff.codeVerifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
        expect(mainWindow().sent).toContain("neore:sign-in");
        expect(takeSignIn()).toBeUndefined();
    });

    it("refuses a callback with a foreign state without ending the flow, so the real callback still completes it", () => {
        const url = startFlow();
        const state = url.searchParams.get("state") ?? "";
        const code = "c".repeat(43);

        fake().appHandlers.get("second-instance")?.({}, [`neore://auth/callback?code=${code}&state=${"x".repeat(22)}`]);
        expect(takeSignIn()).toBeUndefined();

        // The real state still completes the flow, once.
        fake().appHandlers.get("second-instance")?.({}, [`neore://auth/callback?code=${code}&state=${state}`]);
        expect(takeSignIn()).toMatchObject({ code });
        expect(takeSignIn()).toBeUndefined();
    });
});

/**
 * Starts the app again with the tray unable to be created, as `platform`, and returns the notice titles that start raised.
 * Re-importing `main.js` gives a fresh start; the electron mock is the same object, so its handlers are the new ones.
 */
const startWithoutTray = async (platform: NodeJS.Platform, notificationsFail = false): Promise<string[]> => {
    const before = fake().notifications.length;
    const original = Object.getOwnPropertyDescriptor(process, "platform");

    Object.defineProperty(process, "platform", { value: platform });
    fake().trayFails = true;
    fake().notificationFails = notificationsFail;

    try {
        vi.resetModules();
        await import("./main.js");
        fake().appHandlers.get("ready")?.();
    } finally {
        fake().trayFails = false;
        fake().notificationFails = false;

        if (original) {
            Object.defineProperty(process, "platform", original);
        }
    }

    return fake().notifications.slice(before).map((note) => note.title);
};

describe("tray failure", () => {
    it("tells the user on Linux that closing the window will quit Neore", async () => {
        expect(await startWithoutTray("linux")).toContain("Neore has no tray icon");
    });

    it("says nothing on macOS, where the window hides on close without a tray", async () => {
        expect(await startWithoutTray("darwin")).not.toContain("Neore has no tray icon");
    });

    it("still finishes starting when the notice itself cannot be shown", async () => {
        // The composer shortcut is registered after the tray, so a start that aborted at the tray leaves it unregistered.
        fake().shortcuts.delete(COMPOSER_SHORTCUT);

        await expect(startWithoutTray("linux", true)).resolves.toEqual([]);
        expect(fake().shortcuts.has(COMPOSER_SHORTCUT)).toBe(true);
    });
});

/**
 * Starts the app again as `platform`, with `saved` as the window state on disk, and returns the new main window and the
 * state file. Like `startWithoutTray`, it re-imports `main.js`; the windows of the earlier start stay in the fake.
 */
const restart = async (platform: NodeJS.Platform, saved?: { maximized: boolean }): Promise<{ file: string; win: FakeWindow }> => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    const userData = mkdtempSync(path.join(os.tmpdir(), "neore-desktop-test-"));
    const file = path.join(userData, WINDOW_STATE_FILE);
    const first = fake().windows.length;

    if (saved !== undefined) {
        writeFileSync(file, JSON.stringify({ bounds: { height: 700, width: 1000, x: 10, y: 10 }, maximized: saved.maximized }));
    }

    fake().userData = userData;
    Object.defineProperty(process, "platform", { value: platform });

    try {
        vi.resetModules();
        await import("./main.js");
        fake().appHandlers.get("ready")?.();
    } finally {
        if (original) {
            Object.defineProperty(process, "platform", original);
        }
    }

    return { file, win: fake().windows[first] as FakeWindow };
};

const readSaved = (file: string): { maximized: boolean } => JSON.parse(readFileSync(file, "utf8")) as { maximized: boolean };
const readyToShow = (win: FakeWindow): void => (win.handlers.get("ready-to-show") as unknown as () => void)();
const closeWindow = (win: FakeWindow): void => win.handlers.get("close")?.({ preventDefault: () => {} }, "");
const capabilitiesOf = (win: FakeWindow): string[] =>
    ((win.options.webPreferences as { additionalArguments: string[] }).additionalArguments.find((argument) => argument.startsWith(CAPABILITIES_ARG)) ?? "")
        .slice(CAPABILITIES_ARG.length)
        .split(",");

describe("main window reveal and saved state", () => {
    it("maximizes a window saved maximized at its reveal, not at creation, and before showing it", async () => {
        const { win } = await restart("linux", { maximized: true });

        expect(win.options).toMatchObject({ height: 700, show: false, width: 1000 });
        expect(win.calls).toStrictEqual([]);

        readyToShow(win);
        expect(win.calls).toStrictEqual(["maximize", "show"]);
    });

    it("does not maximize a window saved unmaximized", async () => {
        const { win } = await restart("linux", { maximized: false });

        readyToShow(win);
        expect(win.calls).toStrictEqual(["show"]);
    });

    it("keeps the saved maximized state when the window closes before its reveal", async () => {
        const { file, win } = await restart("linux", { maximized: true });

        closeWindow(win);
        expect(readSaved(file).maximized).toBe(true);

        // Once revealed, a close saves what the window is.
        fake().appHandlers.get("second-instance")?.({}, ["neore"]);
        win.maximized = false;
        closeWindow(win);
        expect(readSaved(file).maximized).toBe(false);
    });

    describe("closed before its first paint", () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it("stays hidden at its first paint and at the show fallback", async () => {
            vi.useFakeTimers();

            const { win } = await restart("linux", { maximized: true });

            closeWindow(win);
            readyToShow(win);
            vi.advanceTimersByTime(SHOW_FALLBACK_MS);

            expect(win.calls).toStrictEqual([]);
            expect(win.shown).toBe(false);
        });

        it("is revealed, maximized as saved, when it is brought forward", async () => {
            vi.useFakeTimers();

            const { win } = await restart("darwin", { maximized: true });

            closeWindow(win);
            vi.advanceTimersByTime(SHOW_FALLBACK_MS);
            fake().appHandlers.get("second-instance")?.({}, ["neore"]);
            expect(win.calls).toStrictEqual(["maximize", "show"]);

            readyToShow(win);
            expect(win.calls).toStrictEqual(["maximize", "show"]);
        });
    });

    it("reveals a main window brought forward before its first paint once, maximized, with no second show later", async () => {
        const { win } = await restart("linux", { maximized: true });

        fake().appHandlers.get("second-instance")?.({}, ["neore"]);
        expect(win.calls).toStrictEqual(["maximize", "show"]);

        readyToShow(win);
        expect(win.calls).toStrictEqual(["maximize", "show"]);
    });

    it("draws no vibrancy off macOS", async () => {
        const { win } = await restart("linux");

        expect(win.options).not.toHaveProperty("vibrancy");
        expect(win.options).toMatchObject({ backgroundColor: "#212121" });
        expect(capabilitiesOf(win)).not.toContain("vibrancy");
    });

    it("on macOS draws the sidebar material through a transparent window and advertises it", async () => {
        const { win } = await restart("darwin");

        expect(win.options).toMatchObject({ backgroundColor: "#00000000", vibrancy: "sidebar", visualEffectState: "followWindow" });
        expect(capabilitiesOf(win)).toContain("vibrancy");
    });

    it("off macOS follows the accent through accent-color-changed, not the theme, and sends it to the site windows", async () => {
        const listenersBefore = fake().accentChangedListeners.length;
        const notificationsBefore = fake().macNotifications.length;
        const themeListenersBefore = fake().themeListeners.length;
        const { win } = await restart("linux");
        const added = fake().accentChangedListeners.slice(listenersBefore);

        expect(added).toHaveLength(1);
        expect(fake().macNotifications).toHaveLength(notificationsBefore);
        expect(fake().themeListeners).toHaveLength(themeListenersBefore);

        fake().payloads.length = 0;
        fake().accentColor = "FF0000FF";
        added[0]?.();
        fake().accentColor = "0a84ffff";

        expect(fake().payloads).toContainEqual({ channel: "neore:system-accent-color", payload: "#ff0000", window: win.id });
    });

    it("on macOS follows the accent through AppleColorPreferencesChangedNotification", async () => {
        const listenersBefore = fake().accentChangedListeners.length;
        const notificationsBefore = fake().macNotifications.length;
        const { win } = await restart("darwin");
        const subscribed = fake().macNotifications.slice(notificationsBefore);

        expect(fake().accentChangedListeners).toHaveLength(listenersBefore);
        expect(subscribed.map((entry) => entry.name)).toStrictEqual(["AppleColorPreferencesChangedNotification"]);

        fake().payloads.length = 0;
        fake().accentColor = "34c759ff";
        subscribed[0]?.callback();
        fake().accentColor = "0a84ffff";

        expect(fake().payloads).toContainEqual({ channel: "neore:system-accent-color", payload: "#34c759", window: win.id });
    });
});
