/**
 * The terminal IPC boundary, through the real `registerTerminalIpc` with `electron` mocked and a fake host.
 * The cases are the security decisions: nothing but a terminal window's own page can drive a shell, the
 * site origin has no way in, a window's shell dies with it, and no terminal text goes anywhere but the window.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isTrustedUrl } from "../trust.js";
import type { HostEvent, HostRequest } from "./protocol";
import type { HostHandle } from "./session";

type Frame = { url: string };
type Contents = {
    isDestroyed: () => boolean;
    mainFrame: Frame;
    on: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
};
type FakeWindow = { close: () => void; focus: ReturnType<typeof vi.fn>; options: Record<string, unknown>; webContents: Contents };
type IpcEvent = { sender: Contents; senderFrame: Frame | null };

const fake = vi.hoisted(() => {
    return {
        appListeners: new Map<string, () => void>(),
        clipboardText: "from-clipboard",
        copied: [] as string[],
        handlers: new Map<string, (...args: unknown[]) => unknown>(),
        requestFilter: undefined as undefined | ((details: { url: string }, callback: (response: { cancel: boolean }) => void) => void),
        windows: [] as unknown[],
    };
});

vi.mock("electron", async () => {
    const { pathToFileURL: toFileUrl } = await import("node:url");
    const urlOf = (file: string): string => toFileUrl(file).href;
    const BrowserWindow = function (options: Record<string, unknown>) {
        const listeners = new Map<string, (event?: unknown) => void>();
        const contents = {
            isDestroyed: () => false,
            mainFrame: { url: "" },
            on: vi.fn(),
            send: vi.fn(),
            setWindowOpenHandler: vi.fn(),
        };
        const win = {
            close() {
                listeners.get("closed")?.();
            },
            focus: vi.fn(),
            isMinimized: () => false,
            // The page the window loads is the frame's URL, as in Electron.
            loadFile: (file: string) => {
                contents.mainFrame.url = urlOf(file);
            },
            on: (event: string, listener: () => void) => listeners.set(event, listener),
            options,
            restore: vi.fn(),
            show: vi.fn(),
            webContents: contents,
        };

        fake.windows.push(win);

        return win;
    };

    BrowserWindow.getFocusedWindow = () => null;

    return {
        app: { on: (event: string, listener: () => void) => fake.appListeners.set(event, listener) },
        BrowserWindow,
        clipboard: {
            readText: () => fake.clipboardText,
            writeText: (text: string) => {
                fake.copied.push(text);
            },
        },
        dialog: { showOpenDialog: vi.fn(async () => { return { canceled: true, filePaths: [] }; }) },
        ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => fake.handlers.set(channel, handler) },
        session: {
            fromPartition: () => {
                return {
                    setPermissionCheckHandler: vi.fn(),
                    setPermissionRequestHandler: vi.fn(),
                    webRequest: {
                        onBeforeRequest: (filter: NonNullable<typeof fake.requestFilter>) => {
                            fake.requestFilter = filter;
                        },
                    },
                };
            },
        },
        utilityProcess: { fork: () => { return {}; } },
    };
});

const { registerTerminalIpc } = await import("./index");
const { TERMINAL_CHANNEL, TERMINAL_EVENT } = await import("./channels");

const SITE_ORIGIN = new URL("https://neore.example");
const PAGE_URL = pathToFileURL(path.join(__dirname, "terminal-window", "terminal.html")).href;

/** A host that records what it is sent and lets a test play the shell's side. */
const hosts: { emit: (event: HostEvent) => void; handle: HostHandle; posted: HostRequest[] }[] = [];

const startHost = (): HostHandle => {
    const posted: HostRequest[] = [];
    let message: (event: HostEvent) => void = () => {};
    const handle: HostHandle = {
        kill: vi.fn(),
        onExit: () => {},
        onMessage: (listener) => {
            message = listener;
        },
        post: (request) => {
            posted.push(request);

            if (request.type === "spawn") {
                queueMicrotask(() => message({ pid: 8999 + hosts.length, type: "started" }));
            }
        },
    };

    hosts.push({ emit: (event) => message(event), handle, posted });

    return handle;
};

const folder = realpathSync(path.resolve(__dirname));
const invoke = (channel: string, event: IpcEvent, ...args: unknown[]): unknown => {
    const handler = fake.handlers.get(channel);

    if (handler === undefined) {
        throw new Error(`no handler for ${channel}`);
    }

    return handler(event, ...args);
};

const lastWindow = (): FakeWindow => fake.windows.at(-1) as FakeWindow;
const pageEvent = (win: FakeWindow = lastWindow()): IpcEvent => {
    return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
};
const siteEvent = (): IpcEvent => {
    const sender: Contents = { isDestroyed: () => false, mainFrame: { url: "https://neore.example/chat" }, on: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn() };

    return { sender, senderFrame: sender.mainFrame };
};

let terminals: ReturnType<typeof registerTerminalIpc>;

beforeEach(() => {
    fake.handlers.clear();
    fake.windows.length = 0;
    fake.appListeners.clear();
    fake.copied.length = 0;
    hosts.length = 0;
    terminals = registerTerminalIpc({ startHost });
});

afterEach(() => {
    vi.restoreAllMocks();
});

const startShell = async (win: FakeWindow = lastWindow()) => invoke(TERMINAL_CHANNEL.start, pageEvent(win), { cols: 80, rows: 24 });

describe("who may drive a terminal", () => {
    it("refuses every channel from the site origin, and starts nothing", async () => {
        await terminals.open(folder);

        // The site's frame passes the shell's own origin check, and still gets nothing here.
        expect(isTrustedUrl(SITE_ORIGIN, siteEvent().senderFrame?.url)).toBe(true);

        for (const channel of Object.values(TERMINAL_CHANNEL)) {
            expect(() => invoke(channel, siteEvent(), { cols: 80, rows: 24 })).toThrow("terminal: not a terminal window");
        }

        expect(hosts).toHaveLength(0);
        expect(fake.copied).toHaveLength(0);
    });

    it("refuses a terminal window's subframe, another page, and a window that is not ours", async () => {
        await terminals.open(folder);

        const win = lastWindow();
        const otherPage: IpcEvent = { sender: win.webContents, senderFrame: { url: "file:///elsewhere.html" } };
        const subframe: IpcEvent = { sender: win.webContents, senderFrame: { url: PAGE_URL } };

        for (const event of [otherPage, subframe, siteEvent()]) {
            expect(() => invoke(TERMINAL_CHANNEL.start, event, { cols: 80, rows: 24 })).toThrow("terminal: not a terminal window");
        }

        expect(hosts).toHaveLength(0);
    });

    it("has no way for the page to choose the folder or the shell", async () => {
        await terminals.open(folder);
        await invoke(TERMINAL_CHANNEL.start, pageEvent(), { cols: 80, cwd: "/etc", file: "/bin/evil", rows: 24 });

        const spawn = hosts[0]?.posted[0];

        expect(spawn).toMatchObject({ cwd: folder, type: "spawn" });
        expect(spawn?.type === "spawn" && spawn.file).not.toBe("/bin/evil");
    });
});

describe("opening", () => {
    it("opens one window per folder, titled with the path, and focuses it the second time", async () => {
        await terminals.open(folder);
        await terminals.open(folder);

        expect(fake.windows).toHaveLength(1);
        expect(lastWindow().options.title).toBe(`Terminal — ${folder}`);
        expect(lastWindow().focus).toHaveBeenCalled();
    });

    it("refuses a folder that does not exist, and opens nothing", async () => {
        await expect(terminals.open(path.join(folder, "missing"))).rejects.toThrow("does not exist");
        await expect(terminals.open("relative")).rejects.toThrow("invalid");
        expect(fake.windows).toHaveLength(0);
    });

    it("runs the window sandboxed in an in-memory session that cancels everything but local files", async () => {
        await terminals.open(folder);

        const preferences = lastWindow().options.webPreferences as Record<string, unknown>;

        expect(preferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, partition: "neore-terminal", sandbox: true });
        expect(String(preferences.partition).startsWith("persist:")).toBe(false);

        const answers: boolean[] = [];

        for (const url of ["https://neore.example/api/x", "wss://neore.example/socket", "http://127.0.0.1:8788/chat", pathToFileURL(path.join(folder, "terminal.js")).href]) {
            fake.requestFilter?.({ url }, ({ cancel }) => {
                answers.push(cancel);
            });
        }

        expect(answers).toEqual([true, true, true, false]);
    });
});

describe("unavailable platforms", () => {
    it("refuses cleanly on Windows: nothing is opened or started", async () => {
        const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

        fake.handlers.clear();

        const windows = registerTerminalIpc({ startHost });

        platform.mockRestore();

        expect(windows.availability.available).toBe(false);
        await expect(windows.open(folder)).rejects.toThrow("not available");
        await expect(windows.open(null)).rejects.toThrow("not available");
        expect(fake.windows).toHaveLength(0);
        expect(hosts).toHaveLength(0);
    });
});

describe("a session", () => {
    beforeEach(async () => {
        await terminals.open(folder);
    });

    it("starts the user's shell in the folder with no Neore-only variables", async () => {
        vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
        vi.stubEnv("NEORE_SITE_URL", "https://neore.example");

        const result = await startShell();
        const spawn = hosts[0]?.posted[0];

        expect(result).toMatchObject({ cwd: folder });
        expect(spawn).toMatchObject({ args: ["-l"], cols: 80, cwd: folder, rows: 24, type: "spawn" });
        expect(spawn?.type === "spawn" && Object.keys(spawn.env)).not.toContain("ELECTRON_RUN_AS_NODE");
        expect(spawn?.type === "spawn" && Object.keys(spawn.env)).not.toContain("NEORE_SITE_URL");
        expect(terminals.pids()).toEqual([9000]);
        vi.unstubAllEnvs();
    });

    it("refuses a second shell in the same window while one runs", async () => {
        await startShell();
        await expect(startShell()).rejects.toThrow("already running");
    });

    it("passes input, resizes and acknowledgements to the shell, validated", async () => {
        await startShell();
        await invoke(TERMINAL_CHANNEL.input, pageEvent(), "ls\n");
        await invoke(TERMINAL_CHANNEL.resize, pageEvent(), { cols: 100, rows: 30 });

        expect(hosts[0]?.posted).toContainEqual({ data: "ls\n", type: "input" });
        expect(hosts[0]?.posted).toContainEqual({ cols: 100, rows: 30, type: "resize" });
        expect(() => invoke(TERMINAL_CHANNEL.input, pageEvent(), "")).toThrow("input is invalid");
        expect(() => invoke(TERMINAL_CHANNEL.resize, pageEvent(), { cols: 0, rows: 1 })).toThrow("cols is invalid");
    });

    it("sends the shell's output to its own window, not to another terminal or the clipboard", async () => {
        const first = lastWindow();

        await terminals.open(path.dirname(folder));
        await startShell(first);
        hosts[0]?.emit({ data: "secret-token-123", type: "data" });

        expect(first.webContents.send).toHaveBeenCalledWith(TERMINAL_EVENT.data, "secret-token-123");
        expect(lastWindow().webContents.send).not.toHaveBeenCalled();
        expect(fake.copied).toEqual([]);
    });

    it("tells the window when the shell exits, and lets it start a new one", async () => {
        await startShell();
        hosts[0]?.emit({ exitCode: 0, signal: 0, type: "exit" });

        expect(lastWindow().webContents.send).toHaveBeenCalledWith(TERMINAL_EVENT.exit, { crashed: false, exitCode: 0 });
        expect(terminals.pids()).toEqual([]);

        await startShell();
        expect(hosts).toHaveLength(2);
    });

    it("keeps no session for a shell that exited while its start was being reported", async () => {
        const starting = startShell();

        queueMicrotask(() => hosts[0]?.emit({ exitCode: 0, signal: 0, type: "exit" }));
        await starting;

        expect(terminals.pids()).toEqual([]);

        await startShell();
        expect(hosts).toHaveLength(2);
    });

    it("copies to and pastes from the clipboard for the window only", async () => {
        await invoke(TERMINAL_CHANNEL.copy, pageEvent(), "selected text");

        expect(fake.copied).toEqual(["selected text"]);
        expect(await invoke(TERMINAL_CHANNEL.paste, pageEvent())).toBe("from-clipboard");
    });
});

const loadEvent = (win: FakeWindow, event: string): void => {
    const call = win.webContents.on.mock.calls.find(([name]) => name === event);

    (call?.[1] as () => void)();
};

describe("a page that goes away", () => {
    beforeEach(async () => {
        await terminals.open(folder);
    });

    it("ends its shell on a reload, so the new page starts a fresh one", async () => {
        await startShell();
        loadEvent(lastWindow(), "did-start-loading");

        expect(hosts[0]?.posted).toContainEqual({ type: "kill" });
        expect(terminals.pids()).toEqual([]);

        await startShell();
        expect(hosts).toHaveLength(2);
        expect(terminals.pids()).toEqual([9001]);
    });

    it("ends its shell when the renderer crashes", async () => {
        await startShell();
        loadEvent(lastWindow(), "render-process-gone");

        expect(hosts[0]?.posted).toContainEqual({ type: "kill" });
        expect(terminals.pids()).toEqual([]);
    });

    it("hears nothing from the old shell once the new page has its own", async () => {
        await startShell();
        loadEvent(lastWindow(), "did-start-loading");
        await startShell();
        lastWindow().webContents.send.mockClear();

        hosts[0]?.emit({ data: "old output", type: "data" });
        hosts[0]?.emit({ exitCode: 0, signal: 0, type: "exit" });

        expect(lastWindow().webContents.send).not.toHaveBeenCalled();
        expect(terminals.pids()).toEqual([9001]);
    });

    it("ends a shell that was still starting when the page reloaded", async () => {
        const starting = startShell();

        loadEvent(lastWindow(), "did-start-loading");
        await starting;

        expect(hosts[0]?.posted).toContainEqual({ type: "kill" });
        expect(terminals.pids()).toEqual([]);
        await startShell();
        expect(terminals.pids()).toEqual([9001]);
    });
});

describe("ending a terminal", () => {
    it("hangs up the shell when its window closes, and forgets the window", async () => {
        await terminals.open(folder);
        await startShell();

        const win = lastWindow();

        win.close();

        expect(hosts[0]?.posted).toContainEqual({ type: "kill" });
        expect(terminals.pids()).toEqual([]);
        expect(() => invoke(TERMINAL_CHANNEL.input, pageEvent(win), "x")).toThrow("not a terminal window");
    });

    it("a reopened terminal is a new window and a new shell, with nothing carried over", async () => {
        await terminals.open(folder);
        await startShell();
        lastWindow().close();
        await terminals.open(folder);
        await startShell();

        expect(fake.windows).toHaveLength(2);
        expect(hosts).toHaveLength(2);
        expect(hosts[1]?.posted[0]).toMatchObject({ type: "spawn" });
    });

    it("kills every shell when the app quits", async () => {
        const signal = vi.spyOn(process, "kill").mockImplementation(() => true);

        await terminals.open(folder);
        await startShell();
        await terminals.open(path.dirname(folder));
        await startShell();

        // Electron's order: `before-quit`, then the windows close, then `will-quit`.
        fake.appListeners.get("before-quit")?.();

        expect(signal).toHaveBeenCalledWith(9000, "SIGHUP");
        expect(signal).toHaveBeenCalledWith(9001, "SIGHUP");
        expect(hosts.every((host) => vi.mocked(host.handle.kill).mock.calls.length > 0)).toBe(true);

        for (const window of fake.windows as FakeWindow[]) {
            window.close();
        }

        expect(() => fake.appListeners.get("will-quit")?.()).not.toThrow();
    });

    it("kills a shell that ignored the hangup, and leaves one that is gone", async () => {
        const alive = new Set([9000, 9001]);
        const signal = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
            if (!alive.has(pid)) {
                throw new Error("ESRCH");
            }

            if (sig === "SIGKILL") {
                alive.delete(pid);
            }

            return true;
        });

        await terminals.open(folder);
        await startShell();
        await terminals.open(path.dirname(folder));
        await startShell();

        fake.appListeners.get("before-quit")?.();
        // The first shell exits on the hangup; the second one traps it.
        alive.delete(9000);

        for (const window of fake.windows as FakeWindow[]) {
            window.close();
        }

        fake.appListeners.get("will-quit")?.();

        expect(signal).toHaveBeenCalledWith(9001, "SIGKILL");
        expect(signal).not.toHaveBeenCalledWith(9000, "SIGKILL");
    });

    it("lets shells start again when a quit was cancelled", async () => {
        vi.useFakeTimers();
        vi.spyOn(process, "kill").mockImplementation(() => true);

        try {
            await terminals.open(folder);
            fake.appListeners.get("before-quit")?.();
            vi.advanceTimersByTime(6000);
            await startShell();

            expect(terminals.pids()).toEqual([9000]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not signal the shells of a cancelled quit when the next quit ends", async () => {
        vi.useFakeTimers();

        const signal = vi.spyOn(process, "kill").mockImplementation(() => true);

        try {
            await terminals.open(folder);
            await startShell();
            fake.appListeners.get("before-quit")?.();
            vi.advanceTimersByTime(6000);
            lastWindow().close();
            signal.mockClear();

            fake.appListeners.get("will-quit")?.();

            expect(signal).not.toHaveBeenCalledWith(9000, "SIGKILL");
        } finally {
            vi.useRealTimers();
        }
    });

    it("ends the host of a shell that is still starting", async () => {
        await terminals.open(folder);

        const starting = startShell();

        fake.appListeners.get("before-quit")?.();

        // No session exists yet, so only the host itself can be ended.
        expect(hosts[0]?.handle.kill).toHaveBeenCalled();

        await starting;
    });

    it("keeps nothing of the output after the window closes", async () => {
        // Exposes the collector to this test only.
        setFlagsFromString("--expose-gc");

        const collect = runInNewContext("gc") as () => void;
        const settle = async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });
            collect();
        };

        await terminals.open(folder);
        await startShell();
        await settle();

        const before = process.memoryUsage().heapUsed;

        // 64 MB of distinct text through the shell's window; the window's own copy is the mock's record of the send.
        // Strings stay under V8's external-string size, which would not count toward the heap.
        for (let index = 0; index < 128; index += 1) {
            // A flat string, not a rope: `padEnd`/`repeat` would cost almost no memory and prove nothing.
            hosts[0]?.emit({ data: Buffer.alloc(512 * 1024, index + 1).toString("latin1"), type: "data" });
        }

        lastWindow().close();
        lastWindow().webContents.send.mockClear();
        await settle();

        // Nothing in the controller or the session still points at the text.
        expect(process.memoryUsage().heapUsed - before).toBeLessThan(16 * 1024 * 1024);
    });
});
