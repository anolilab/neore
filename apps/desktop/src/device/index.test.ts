/**
 * The device IPC boundary, through the real `registerDeviceIpc` with `electron`
 * and the addon mocked. The cases are the security decisions: who may call the
 * relay, who may call the local window's commands, where events go, and what
 * happens to a prompt when its window closes.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { isTrustedUrl } from "../trust.js";
import type { DeviceIpcOptions } from "./index";

type Frame = { url: string };
type WebContents = {
    destroy: () => void;
    destroyed: boolean;
    isDestroyed: () => boolean;
    mainFrame: Frame;
    once: (event: string, listener: () => void) => void;
    send: ReturnType<typeof vi.fn>;
};
type IpcEvent = { sender: WebContents; senderFrame: Frame | null };

const fake = vi.hoisted(() => {
    return {
        appListeners: new Map<string, () => void>(),
        coreEmit: undefined as undefined | ((json: string) => void),
        coreImpl: undefined as undefined | Record<string, ReturnType<typeof vi.fn>>,
        coreThrows: false,
        handlers: new Map<string, (...args: unknown[]) => unknown>(),
        notifications: [] as { body?: string; title: string }[],
        windows: [] as { close: () => void; webContents: WebContents }[],
    };
});

vi.mock("electron", () => {
    const contentsOf = (): WebContents => {
        const contents: WebContents = {
            destroy: () => {},
            destroyed: false,
            isDestroyed: () => contents.destroyed,
            mainFrame: { url: "file:///app/device.html" },
            once: () => {},
            send: vi.fn(),
        };

        return contents;
    };

    // A constructor function returning an object hands that object back as the instance.
    const BrowserWindow = function () {
        const listeners = new Map<string, () => void>();
        const win = {
            close() {
                win.destroyed = true;
                listeners.get("closed")?.();
            },
            destroyed: false,
            focus: (): void => {},
            isDestroyed: (): boolean => win.destroyed,
            isMinimized: (): boolean => false,
            loadFile: (): Promise<void> => Promise.resolve(),
            on: (event: string, listener: () => void): void => {
                listeners.set(event, listener);
            },
            restore: (): void => {},
            show: (): void => {},
            webContents: Object.assign(contentsOf(), { on: vi.fn(), setWindowOpenHandler: vi.fn() }),
        };

        fake.windows.push(win);

        return win;
    };

    const NotificationStub = function (options: { body?: string; title: string }) {
        fake.notifications.push(options);

        return { options, show: () => {} };
    };

    return {
        app: {
            getPath: () => "/user-data",
            getVersion: () => "1.2.3",
            on: (event: string, listener: () => void) => fake.appListeners.set(event, listener),
        },
        BrowserWindow,
        dialog: {
            showOpenDialog: vi.fn(async () => {
                return { canceled: false, filePaths: ["/shared/picked"] };
            }),
        },
        ipcMain: {
            handle: (channel: string, handler: (...args: unknown[]) => unknown) => fake.handlers.set(channel, handler),
        },
        Notification: Object.assign(NotificationStub, { isSupported: () => true }),
    };
});

vi.mock("./addon", () => {
    const CoreStub = function (_dataDirectory: string, onEvent: (json: string) => void) {
        fake.coreEmit = onEvent;

        return fake.coreImpl as never;
    };

    return {
        loadDeviceCore: () => {
            if (fake.coreThrows) {
                throw new Error("Cannot find module '@neore/device-core-node'");
            }

            return CoreStub;
        },
    };
});

const spawnAgent = vi.hoisted(() => vi.fn());

vi.mock("../acp/process", () => {
    return { acpSupported: true, spawnAgent };
});

const { registerDeviceIpc } = await import("./index");
const { DEVICE_CHANNEL, LOCAL_CHANNEL } = await import("./channels");

const SITE_ORIGIN = new URL("https://neore.example");
const options: DeviceIpcOptions = {
    isTrusted: (event) => isTrustedUrl(SITE_ORIGIN, event.senderFrame?.url),
};

const siteWebContents = (url: string): WebContents => {
    const listeners = new Map<string, () => void>();

    return {
        destroy: () => listeners.get("destroyed")?.(),
        destroyed: false,
        isDestroyed: () => false,
        mainFrame: { url },
        once: (event, listener) => {
            listeners.set(event, listener);
        },
        send: vi.fn(),
    };
};

let siteContents: WebContents;
const siteEvent = (): IpcEvent => {
    return { sender: siteContents, senderFrame: { url: "https://neore.example/chat" } };
};
const foreignEvent = (): IpcEvent => {
    return {
        sender: { ...siteContents, send: vi.fn() },
        senderFrame: { url: "https://evil.example/" },
    };
};
const deviceWindow = (): { close: () => void; webContents: WebContents } => {
    const win = fake.windows[0];

    if (win === undefined) {
        throw new Error("the device window was never opened");
    }

    return win;
};
// The page the window loads, as `index.ts` computes it.
const LOCAL_PAGE_URL = pathToFileURL(path.join(__dirname, "device-window", "device.html")).href;

const localEvent = (): IpcEvent => {
    const win = deviceWindow();

    win.webContents.mainFrame.url = LOCAL_PAGE_URL;

    return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
};

const invoke = (channel: string, event: IpcEvent, ...args: unknown[]): unknown => {
    const handler = fake.handlers.get(channel);

    if (handler === undefined) {
        throw new Error(`no handler for ${channel}`);
    }

    return handler(event, ...args);
};

const makeCore = () => {
    return {
        acpSpawnPlan: vi.fn((): string => {
            throw new Error("that folder is not allowed");
        }),
        acpUpdate: vi.fn(() => JSON.stringify({ agents: [], envNames: [] })),
        acpView: vi.fn(() => JSON.stringify({ agents: [{ args: [], command: "agent", envNames: [], key: "alpha", label: "Alpha" }], envNames: [] })),
        auditTail: vi.fn(() => ["{}"]),
        denyPrompts: vi.fn(),
        execute: vi.fn(async () => JSON.stringify({ payload: "{}", signature: "s" })),
        manifest: vi.fn(async () => JSON.stringify({ payload: "{}", signature: "m" })),
        pair: vi.fn(async () => true),
        promptAnswer: vi.fn(),
        promptCurrent: vi.fn(() => null),
        reapIdleServers: vi.fn(),
        settingsGet: vi.fn(() => JSON.stringify({ paired: false, roots: [] })),
        settingsUpdate: vi.fn(() => JSON.stringify({ paired: false, roots: ["/x"] })),
        status: vi.fn(() => JSON.stringify({ accountLabel: null, deviceId: null, platform: "macos" })),
        stop: vi.fn(),
    };
};

let core: ReturnType<typeof makeCore>;

beforeEach(() => {
    fake.handlers.clear();
    fake.windows.length = 0;
    fake.notifications.length = 0;
    fake.appListeners.clear();
    fake.coreEmit = undefined;
    fake.coreThrows = false;
    core = makeCore();
    fake.coreImpl = core;
    siteContents = siteWebContents("https://neore.example/chat");
    registerDeviceIpc(options);
});

describe("relay channels (the site window)", () => {
    it("refuse every sender but the site", () => {
        for (const channel of [DEVICE_CHANNEL.status, DEVICE_CHANNEL.manifest, DEVICE_CHANNEL.openSettings]) {
            expect(() => invoke(channel, foreignEvent())).toThrow("device: untrusted sender");
        }

        expect(() => invoke(DEVICE_CHANNEL.pair, foreignEvent(), {})).toThrow("device: untrusted sender");
        expect(() => invoke(DEVICE_CHANNEL.execute, foreignEvent(), {})).toThrow("device: untrusted sender");
        expect(core.execute).not.toHaveBeenCalled();
        expect(core.pair).not.toHaveBeenCalled();
    });

    it("pass a trusted call to the core unchanged", async () => {
        const result = await invoke(DEVICE_CHANNEL.execute, siteEvent(), { envelope: "{}", signature: "a".repeat(64) });

        expect(core.execute).toHaveBeenCalledWith("{}", "a".repeat(64));
        expect(result).toEqual({ payload: "{}", signature: "s" });
    });

    it("pass the pairing through and reject a malformed one before the core", async () => {
        await invoke(DEVICE_CHANNEL.pair, siteEvent(), { accountLabel: "me", deviceId: "dev_1", secret: "b".repeat(64) });

        expect(core.pair).toHaveBeenCalledWith("dev_1", "b".repeat(64), "me");
        expect(() => invoke(DEVICE_CHANNEL.pair, siteEvent(), { deviceId: 7, secret: "x" })).toThrow("device: deviceId is invalid");
    });

    it("reject a malformed or oversized call before it reaches the core", async () => {
        await expect(invoke(DEVICE_CHANNEL.execute, siteEvent(), { envelope: 42, signature: "x" })).rejects.toThrow("device: envelope is invalid");
        await expect(invoke(DEVICE_CHANNEL.execute, siteEvent(), { envelope: "x".repeat(300_000), signature: "x" })).rejects.toThrow(
            "device: envelope is invalid",
        );
        expect(core.execute).not.toHaveBeenCalled();
    });

    it("refuse the approval and settings commands from the site", () => {
        expect(() => invoke(LOCAL_CHANNEL.promptAnswer, siteEvent(), 1, "once")).toThrow("device: not the device window");
        expect(() => invoke(LOCAL_CHANNEL.settingsGet, siteEvent())).toThrow("device: not the device window");
        expect(() => invoke(LOCAL_CHANNEL.pickFolder, siteEvent())).toThrow("device: not the device window");
        expect(core.promptAnswer).not.toHaveBeenCalled();
    });
});

describe("local channels (the device window)", () => {
    beforeEach(() => {
        invoke(DEVICE_CHANNEL.openSettings, siteEvent());
    });

    it("refuse a frame that is not the device page, a subframe, or a foreign contents", () => {
        const win = deviceWindow();
        const otherPage: IpcEvent = { sender: win.webContents, senderFrame: { url: "file:///elsewhere.html" } };
        const subframe: IpcEvent = { sender: win.webContents, senderFrame: { url: "file:///app/device.html" } };

        expect(() => invoke(LOCAL_CHANNEL.settingsGet, otherPage)).toThrow("device: not the device window");
        expect(() => invoke(LOCAL_CHANNEL.settingsGet, subframe)).toThrow("device: not the device window");
        expect(() => invoke(LOCAL_CHANNEL.settingsGet, foreignEvent())).toThrow("device: not the device window");
    });

    it("answer a prompt through the core from the device window", () => {
        invoke(LOCAL_CHANNEL.promptAnswer, localEvent(), 7, "once");

        expect(core.promptAnswer).toHaveBeenCalledWith(7, "once");
        expect(() => invoke(LOCAL_CHANNEL.promptAnswer, localEvent(), 7, "everything")).toThrow("device: answer is invalid");
        expect(() => invoke(LOCAL_CHANNEL.promptAnswer, localEvent(), 1.5, "once")).toThrow("device: prompt id is invalid");
    });
});

describe("coding-agent channels", () => {
    const ACP_CHANNELS = [
        LOCAL_CHANNEL.acpCancel,
        LOCAL_CHANNEL.acpClose,
        LOCAL_CHANNEL.acpForget,
        LOCAL_CHANNEL.acpProbe,
        LOCAL_CHANNEL.acpSend,
        LOCAL_CHANNEL.acpSession,
        LOCAL_CHANNEL.acpSessions,
        LOCAL_CHANNEL.acpStart,
        LOCAL_CHANNEL.acpUpdate,
        LOCAL_CHANNEL.acpView,
    ];

    beforeEach(() => {
        spawnAgent.mockReset();
        invoke(DEVICE_CHANNEL.openSettings, siteEvent());
    });

    it("answer the device window only: the site and foreign frames reach nothing", () => {
        for (const channel of ACP_CHANNELS) {
            expect(() => invoke(channel, siteEvent(), "alpha", "/work")).toThrow("device: not the device window");
            expect(() => invoke(channel, foreignEvent(), "alpha", "/work")).toThrow("device: not the device window");
        }

        expect(core.acpUpdate).not.toHaveBeenCalled();
        expect(core.acpSpawnPlan).not.toHaveBeenCalled();
        expect(spawnAgent).not.toHaveBeenCalled();
    });

    it("are not on the relay: the site preload's channels carry none of them", () => {
        for (const channel of Object.values(DEVICE_CHANNEL)) {
            expect(channel).not.toContain("acp");
        }
    });

    it("never start a process the core did not plan: a refused plan spawns nothing", async () => {
        await expect(invoke(LOCAL_CHANNEL.acpStart, localEvent(), "alpha", "/not/allowed")).rejects.toThrow("that folder is not allowed");
        await expect(invoke(LOCAL_CHANNEL.acpProbe, localEvent(), "alpha")).rejects.toThrow("that folder is not allowed");

        expect(core.acpSpawnPlan).toHaveBeenCalledWith("alpha", "/not/allowed");
        expect(spawnAgent).not.toHaveBeenCalled();
    });

    it("refuse an unregistered agent before asking for a plan", async () => {
        await expect(invoke(LOCAL_CHANNEL.acpStart, localEvent(), "nobody", "/work")).rejects.toThrow("that agent is not registered");

        expect(core.acpSpawnPlan).not.toHaveBeenCalled();
    });

    it("check the shape of what the window sends before it reaches the core", () => {
        expect(() => invoke(LOCAL_CHANNEL.acpUpdate, localEvent(), "a string")).toThrow("device: agent update is invalid");
        expect(() => invoke(LOCAL_CHANNEL.acpUpdate, localEvent(), { op: "setEnv", value: "x".repeat(300_000) })).toThrow("too large");
        expect(core.acpUpdate).not.toHaveBeenCalled();

        invoke(LOCAL_CHANNEL.acpUpdate, localEvent(), { name: "HTTPS_PROXY", op: "setEnv", value: "https://proxy" });

        expect(core.acpUpdate).toHaveBeenCalledWith(JSON.stringify({ name: "HTTPS_PROXY", op: "setEnv", value: "https://proxy" }));
    });
});

describe("events", () => {
    it("send a progress report to the site that made the call, never to the device window", async () => {
        invoke(DEVICE_CHANNEL.openSettings, siteEvent());
        await invoke(DEVICE_CHANNEL.execute, siteEvent(), { envelope: "{}", signature: "a".repeat(64) });

        fake.coreEmit?.(JSON.stringify({ callId: "c1", payload: "{}", signature: "p", type: "progress" }));

        expect(siteContents.send).toHaveBeenCalledWith(DEVICE_CHANNEL.progress, { callId: "c1", payload: "{}", signature: "p" });
        expect(deviceWindow().webContents.send).not.toHaveBeenCalledWith(DEVICE_CHANNEL.progress, expect.anything());
    });

    it("opens the device window and notifies on a prompt", () => {
        fake.coreEmit?.(
            JSON.stringify({
                prompt: {
                    body: { allowAlways: false, detail: "ls", input: "{}", kind: "call", taintedBy: [], threadTitle: "T", tool: "fs_list", toolKind: "fs" },
                    expiresAt: 1,
                    id: 3,
                },
                type: "prompt",
            }),
        );

        expect(fake.windows).toHaveLength(1);
        expect(fake.notifications).toEqual([{ body: "fs_list — T", title: "Neore is asking for your approval" }]);
    });

    it("tells the site its tool set changed when the core says so", () => {
        invoke(DEVICE_CHANNEL.status, siteEvent());
        fake.coreEmit?.(JSON.stringify({ type: "changed" }));

        expect(siteContents.send).toHaveBeenCalledWith(DEVICE_CHANNEL.changed, undefined);
    });

    it("sends events to every open site window, and only to the open ones", () => {
        const thread = siteWebContents("https://neore.example/chat/thread");

        invoke(DEVICE_CHANNEL.status, siteEvent());
        invoke(DEVICE_CHANNEL.status, { sender: thread, senderFrame: thread.mainFrame });
        fake.coreEmit?.(JSON.stringify({ type: "changed" }));

        expect(siteContents.send).toHaveBeenCalledWith(DEVICE_CHANNEL.changed, undefined);
        expect(thread.send).toHaveBeenCalledWith(DEVICE_CHANNEL.changed, undefined);

        thread.destroy();
        thread.send.mockClear();
        fake.coreEmit?.(JSON.stringify({ type: "changed" }));

        expect(thread.send).not.toHaveBeenCalled();
        expect(siteContents.send).toHaveBeenCalledWith(DEVICE_CHANNEL.changed, undefined);
    });

    it("denies every pending prompt when the device window closes", () => {
        invoke(DEVICE_CHANNEL.openSettings, siteEvent());
        deviceWindow().close();

        expect(core.denyPrompts).toHaveBeenCalledTimes(1);
    });
});

describe("when the addon cannot load", () => {
    it("still registers the channels and rejects each with the reason", () => {
        fake.coreThrows = true;
        fake.handlers.clear();
        registerDeviceIpc(options);

        expect(() => invoke(DEVICE_CHANNEL.status, siteEvent())).toThrow("device execution is unavailable");
        expect(fake.handlers.has(LOCAL_CHANNEL.settingsGet)).toBe(true);
    });
});

describe("shutdown", () => {
    it("stops the core on quit", () => {
        fake.appListeners.get("will-quit")?.();

        expect(core.stop).toHaveBeenCalledTimes(1);
    });
});
