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
        auditTail: vi.fn(() => ["{}"]),
        denyPrompts: vi.fn(),
        execute: vi.fn(async () => JSON.stringify({ payload: "{}", signature: "s" })),
        hostConnect: vi.fn(async () => JSON.stringify({ platform: "linux" })),
        hostDisconnect: vi.fn(),
        hostForgetKey: vi.fn(),
        hostPair: vi.fn(async (_spec: string, _deviceId: string, _secret: string) => true),
        hostProbe: vi.fn(async (_spec: string) => JSON.stringify({ platform: "linux", sandboxAvailable: true, sandboxDetail: "Landlock", version: "0.1.0" })),
        hostRemove: vi.fn(),
        manifest: vi.fn(async (_deviceId?: string) => JSON.stringify({ payload: "{}", signature: "m" })),
        pair: vi.fn(async () => true),
        promptAnswer: vi.fn(),
        promptCurrent: vi.fn(() => null),
        promptSecret: vi.fn(),
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

describe("servers over SSH", () => {
    const spec = { address: "build.example.com", name: "build-box", port: 2222, user: "deploy" };

    it("refuse every sender but the site", () => {
        for (const channel of [DEVICE_CHANNEL.hostProbe, DEVICE_CHANNEL.hostConnect, DEVICE_CHANNEL.hostDisconnect]) {
            expect(() => invoke(channel, foreignEvent(), spec)).toThrow("device: untrusted sender");
        }

        expect(() => invoke(DEVICE_CHANNEL.hostPair, foreignEvent(), {})).toThrow("device: untrusted sender");
        expect(core.hostProbe).not.toHaveBeenCalled();
        expect(core.hostPair).not.toHaveBeenCalled();
    });

    it("pass a validated server and its secret to the core as JSON", async () => {
        await expect(invoke(DEVICE_CHANNEL.hostProbe, siteEvent(), spec)).resolves.toMatchObject({ platform: "linux" });
        expect(JSON.parse(core.hostProbe.mock.calls[0]?.[0] as string)).toEqual(spec);

        // Agent forwarding is not the page's to ask for: it never reaches the core.
        await invoke(DEVICE_CHANNEL.hostProbe, siteEvent(), { ...spec, forwardAgent: true });

        expect(core.hostProbe.mock.calls[1]?.[0]).not.toContain("forwardAgent");

        await invoke(DEVICE_CHANNEL.hostPair, siteEvent(), { deviceId: "host-1", secret: "c".repeat(64), spec: { ...spec, identityFile: "/home/me/.ssh/id" } });

        expect(core.hostPair).toHaveBeenCalledWith(expect.stringContaining("\"identityFile\":\"/home/me/.ssh/id\""), "host-1", "c".repeat(64));
    });

    it("reject a malformed server before the core", async () => {
        await expect(invoke(DEVICE_CHANNEL.hostProbe, siteEvent(), { ...spec, port: 70_000 })).rejects.toThrow("device: port is invalid");
        await expect(invoke(DEVICE_CHANNEL.hostProbe, siteEvent(), { ...spec, address: "" })).rejects.toThrow("device: address is invalid");
        await expect(invoke(DEVICE_CHANNEL.hostProbe, siteEvent(), { ...spec, user: 7 })).rejects.toThrow("device: user is invalid");
        await expect(invoke(DEVICE_CHANNEL.hostProbe, siteEvent(), "build-box")).rejects.toThrow("device: server is invalid");
        await expect(invoke(DEVICE_CHANNEL.hostPair, siteEvent(), { deviceId: "host-1", secret: "x", spec: {} })).rejects.toThrow("is invalid");
        expect(core.hostProbe).not.toHaveBeenCalled();
    });

    it("ask the core for a server's own manifest by its device id", async () => {
        await invoke(DEVICE_CHANNEL.manifest, siteEvent(), "host-1");
        await invoke(DEVICE_CHANNEL.manifest, siteEvent());

        expect(core.manifest.mock.calls).toEqual([["host-1"], [undefined]]);
        await expect(invoke(DEVICE_CHANNEL.manifest, siteEvent(), 7)).rejects.toThrow("device: deviceId is invalid");
    });

    it("keep removing a server and forgetting its key out of the page's reach", () => {
        for (const channel of [LOCAL_CHANNEL.hostRemove, LOCAL_CHANNEL.hostForgetKey, LOCAL_CHANNEL.hostConnect, LOCAL_CHANNEL.hostDisconnect]) {
            expect(() => invoke(channel, siteEvent(), "host-1")).toThrow("device: not the device window");
        }

        expect(core.hostRemove).not.toHaveBeenCalled();
        expect(core.hostForgetKey).not.toHaveBeenCalled();
    });

    it("let the device window manage a server", async () => {
        invoke(DEVICE_CHANNEL.openSettings, siteEvent());
        invoke(LOCAL_CHANNEL.hostForgetKey, localEvent(), "host-1");
        invoke(LOCAL_CHANNEL.hostRemove, localEvent(), "host-1");
        invoke(LOCAL_CHANNEL.hostDisconnect, localEvent(), "host-1");
        await invoke(LOCAL_CHANNEL.hostConnect, localEvent(), "host-1");

        expect(core.hostForgetKey).toHaveBeenCalledWith("host-1");
        expect(core.hostRemove).toHaveBeenCalledWith("host-1");
        expect(core.hostDisconnect).toHaveBeenCalledWith("host-1");
        expect(core.hostConnect).toHaveBeenCalledWith("host-1");
    });
});

describe("passphrases", () => {
    beforeEach(() => {
        invoke(DEVICE_CHANNEL.openSettings, siteEvent());
    });

    it("answer a passphrase prompt only from the device window, on a channel of its own", () => {
        expect(() => invoke(LOCAL_CHANNEL.promptSecret, siteEvent(), 4, "hunter2")).toThrow("device: not the device window");
        expect(() => invoke(LOCAL_CHANNEL.promptSecret, foreignEvent(), 4, "hunter2")).toThrow("device: not the device window");
        expect(core.promptSecret).not.toHaveBeenCalled();

        invoke(LOCAL_CHANNEL.promptSecret, localEvent(), 4, "hunter2");

        expect(core.promptSecret).toHaveBeenCalledWith(4, "hunter2");
        // It is not a plain answer: the ordinary channel refuses it.
        expect(() => invoke(LOCAL_CHANNEL.promptAnswer, localEvent(), 4, "hunter2")).toThrow("device: answer is invalid");
    });

    it("refuse a malformed secret without ever putting it in the error", () => {
        for (const bad of ["", "x".repeat(2000), "a\nb", 12]) {
            let message = "";

            try {
                invoke(LOCAL_CHANNEL.promptSecret, localEvent(), 4, bad);
            } catch (error) {
                message = String(error);
            }

            expect(message).toContain("device: passphrase is invalid");
            expect(message).not.toContain("x".repeat(20));
        }

        expect(() => invoke(LOCAL_CHANNEL.promptSecret, localEvent(), 0, "ok")).toThrow("device: prompt id is invalid");
        expect(core.promptSecret).not.toHaveBeenCalled();
    });

    it("never forwards a passphrase into an event or a notification", () => {
        invoke(LOCAL_CHANNEL.promptSecret, localEvent(), 4, "correct horse");
        fake.coreEmit?.(
            JSON.stringify({ prompt: { body: { host: "deploy@build", kind: "passphrase", prompt: "Enter passphrase for key" }, expiresAt: 1, id: 5 }, type: "prompt" }),
        );

        expect(JSON.stringify(fake.notifications)).not.toContain("correct horse");
        expect(fake.notifications.at(-1)?.body).toBe("A key passphrase for deploy@build");
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

describe("events", () => {
    it("send a progress report to the site that made the call, never to the device window", async () => {
        invoke(DEVICE_CHANNEL.openSettings, siteEvent());
        await invoke(DEVICE_CHANNEL.execute, siteEvent(), { envelope: "{}", signature: "a".repeat(64) });

        fake.coreEmit?.(JSON.stringify({ callId: "c1", deviceId: "host-1", payload: "{}", signature: "p", type: "progress" }));

        // The report says which device it is for: a server's progress is signed with that server's secret.
        expect(siteContents.send).toHaveBeenCalledWith(DEVICE_CHANNEL.progress, { callId: "c1", deviceId: "host-1", payload: "{}", signature: "p" });
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

    it("words a notification for each kind of prompt", () => {
        const notify = (body: Record<string, unknown>) => {
            fake.coreEmit?.(JSON.stringify({ prompt: { body, expiresAt: 1, id: 9 }, type: "prompt" }));

            return fake.notifications.at(-1)?.body;
        };

        expect(notify({ address: "build", identityFile: null, kind: "hostConnect", name: "build-box", port: 22, user: "deploy" })).toBe("Connect to deploy@build?");
        expect(notify({ fingerprint: "SHA256:x", host: "build", identityFile: null, keyType: "ED25519", kind: "hostKey", port: 22 })).toBe("Trust the key of build?");
        expect(notify({ host: "build", kind: "hostKeyChanged", pinned: [], port: 22, presented: [] })).toBe("The key of build changed");
        expect(notify({ address: "build", identityFile: null, kind: "hostPairing", name: "build-box", port: 22, user: "u" })).toBe("Add the server build-box");
        expect(
            notify({ allowAlways: false, detail: "ls", host: "build-box", input: "{}", kind: "call", taintedBy: [], threadTitle: "T", tool: "fs_list", toolKind: "fs" }),
        ).toBe("fs_list on build-box — T");
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
