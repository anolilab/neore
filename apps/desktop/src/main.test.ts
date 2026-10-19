/**
 * Exercises the main process through its real handlers, with `electron` mocked.
 * The real-binary suite (`e2e/`) covers the same paths against Electron 44; these
 * cases pin the security decisions and the handoffs. Mocking `electron` is the
 * only way to reach IPC handlers without launching it.
 */
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

type Listener = (event: { preventDefault: () => void }, url: string) => void;

interface FakeWindow {
    focused: boolean;
    handlers: Map<string, Listener>;
    hidden: boolean;
    id: number;
    loaded: string[];
    sent: string[];
    shown: boolean;
    webContents: {
        handlers: Map<string, Listener>;
        id: number;
        loadURL: (url: string) => Promise<void>;
        on: (event: string, listener: Listener) => void;
        send: (channel: string) => void;
        setWindowOpenHandler: (listener: (details: { url: string }) => { action: string }) => void;
        windowOpen?: (details: { url: string }) => { action: string };
    };
}

interface Fake {
    appHandlers: Map<string, (...args: unknown[]) => void>;
    ipc: Map<string, (event: unknown, payload?: unknown) => unknown>;
    notifications: { body?: string; title: string }[];
    opened: string[];
    permissionCheck?: (wc: unknown, permission: string, requestingOrigin: string) => boolean;
    permissionRequest?: (wc: unknown, permission: string, callback: (isAllowed: boolean) => void, details: { requestingUrl: string }) => void;
    shortcuts: Map<string, () => void>;
    trays: number;
    windows: FakeWindow[];
}

vi.mock("electron", () => {
    const fakeElectron: Fake = {
        appHandlers: new Map(),
        ipc: new Map(),
        notifications: [],
        opened: [],
        shortcuts: new Map(),
        trays: 0,
        windows: [],
    };

    /** A window record: its state and the methods `main.ts` calls, all on one object. */
    const createWindow = (): FakeWindow => {
        const id = fakeElectron.windows.length + 1;
        const handlers = new Map<string, Listener>();
        const webHandlers = new Map<string, Listener>();
        const window = {
            center: () => {},
            focus: () => {},
            focused: true,
            handlers,
            hidden: false,
            hide: () => {
                window.shown = false;
                window.hidden = true;
            },
            id,
            isFocused: () => window.focused,
            isMinimized: () => false,
            isVisible: () => window.shown,
            loaded: [] as string[],
            loadURL: (url: string) => {
                window.loaded.push(url);

                return Promise.resolve();
            },
            on: (event: string, listener: Listener) => {
                handlers.set(event, listener);

                return window;
            },
            restore: () => {},
            sent: [] as string[],
            show: () => {
                window.shown = true;
                window.hidden = false;
            },
            shown: false,
            webContents: {
                handlers: webHandlers,
                id,
                loadURL: (url: string) => {
                    window.loaded.push(url);

                    return Promise.resolve();
                },
                on: (event: string, listener: Listener) => {
                    webHandlers.set(event, listener);
                },
                send: (channel: string) => {
                    window.sent.push(channel);
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
    const FakeBrowserWindow = function FakeBrowserWindow() {
        return createWindow();
    };

    const FakeTray = function FakeTray() {
        fakeElectron.trays += 1;

        return { on: () => {}, setContextMenu: () => {}, setToolTip: () => {} };
    };

    const FakeNotification = function FakeNotification(options: { body?: string; title: string }) {
        fakeElectron.notifications.push(options);

        return { show: () => {} };
    };

    return {
        app: {
            getPath: () => path.join(os.tmpdir(), "neore-desktop-test"),
            isPackaged: false,
            isReady: () => true,
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
        },
        Menu: {
            buildFromTemplate: () => {
                return {};
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
        Notification: FakeNotification,
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
    return { senderFrame: { url } };
};
const siteSender = () => sender(`${SITE}/chat`);
const mainWindow = (): FakeWindow => fake().windows[0];
const composer = (): FakeWindow => fake().windows[1];

/** The composer's own sender: its window's webContents, on its own file URL. */
const composerSender = () => {
    return { sender: { id: composer().webContents.id }, senderFrame: { url: composer().loaded[0] } };
};

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

    it("hands a popup to another origin to the system browser and opens no window", async () => {
        const result = mainWindow().webContents.windowOpen?.({ url: "https://example.org/x" });

        expect(result).toStrictEqual({ action: "deny" });
        await vi.waitFor(() => expect(fake().opened).toStrictEqual(["https://example.org/x"]));
        // The main window and the (hidden) Quick Composer; nothing else.
        expect(fake().windows).toHaveLength(2);
    });

    it("keeps a same-origin popup in the main window", () => {
        const result = mainWindow().webContents.windowOpen?.({ url: `${SITE}/chat/thread-1` });

        expect(result).toStrictEqual({ action: "deny" });
        expect(mainWindow().loaded).toContain(`${SITE}/chat/thread-1`);
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

    it("lets navigation to ordinary origins through", () => {
        let isPrevented = false;

        guardOf(mainWindow(), "will-navigate")?.(
            {
                preventDefault: () => {
                    isPrevented = true;
                },
            },
            "https://example.org/",
        );
        expect(isPrevented).toBe(false);
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
        const otherPage = { sender: { id: composer().webContents.id }, senderFrame: { url: "file:///elsewhere/index.html" } };

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

            fake().permissionRequest?.({}, permission, (value) => {
                isAllowed = value;
            }, { requestingUrl });

            return isAllowed;
        };

        expect(decide("notifications", `${SITE}/chat`)).toBe(true);
        expect(decide("notifications", "https://example.org/")).toBe(false);
        expect(decide("geolocation", `${SITE}/chat`)).toBe(false);
        expect(fake().permissionCheck?.({}, "media", SITE)).toBe(true);
        expect(fake().permissionCheck?.({}, "media", "https://example.org")).toBe(false);
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

    it("hands a deep-linked compose to the page once, and only to the site", () => {
        fake().appHandlers.get("second-instance")?.({}, ["neore", "neore://new?text=hello%20there"]);

        const take = fake().ipc.get("neore:take-pending-compose");

        expect(take?.(sender("https://example.org/"))).toBeUndefined();
        expect(take?.(siteSender())).toBe("hello there");
        expect(take?.(siteSender())).toBeUndefined();
        expect(mainWindow().sent).toContain("neore:compose");
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

    it("drops a callback with a foreign state, and the flow is spent", () => {
        const url = startFlow();
        const state = url.searchParams.get("state") ?? "";
        const code = "c".repeat(43);

        fake().appHandlers.get("second-instance")?.({}, [`neore://auth/callback?code=${code}&state=${"x".repeat(22)}`]);
        expect(takeSignIn()).toBeUndefined();

        // The real state arrives after the flow was consumed: still refused.
        fake().appHandlers.get("second-instance")?.({}, [`neore://auth/callback?code=${code}&state=${state}`]);
        expect(takeSignIn()).toBeUndefined();
    });
});
