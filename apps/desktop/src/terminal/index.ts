/**
 * The local terminal in the Electron main process: one window per folder, one shell per window.
 *
 * A terminal is a shell running as the user, outside the device sandbox, so it is reachable from one
 * place only: the terminal window's own page. The site's preload has no terminal channel, and every
 * handler here checks that the sender is a terminal window's main frame on our own page. The window
 * runs in an in-memory session that cancels every request but `file:`, so nothing a shell prints can
 * leave the machine from here, and nothing is written to disk.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { BrowserWindow as BrowserWindowInstance, IpcMainInvokeEvent, Session, WebContents } from "electron";
import { app, BrowserWindow, clipboard, dialog, ipcMain, session as electronSession, utilityProcess } from "electron";

import { TERMINAL_CHANNEL, TERMINAL_EVENT } from "./channels";
import type { HostEvent, HostRequest } from "./protocol";
import type { HostHandle, TerminalSession } from "./session";
import { startSession } from "./session";
import type { Availability } from "./shell";
import { readFolder, resolveShell, shellEnvironment, terminalAvailability } from "./shell";
import { readAck, readCopy, readInput, readSize } from "./validate";

const WINDOW_DIR = path.join(__dirname, "terminal-window");
const TERMINAL_PAGE = path.join(WINDOW_DIR, "terminal.html");
const TERMINAL_PRELOAD = path.join(WINDOW_DIR, "preload.cjs");
const HOST_PATH = path.join(__dirname, "terminal-host.cjs");
/** No `persist:` prefix: the session lives in memory and is gone when the app quits. */
const PARTITION = "neore-terminal";

interface Entry {
    closed: boolean;
    cwd: string;
    /** Counts the page loads this window has had; a shell belongs to the load it was started for. */
    epoch: number;
    session?: TerminalSession;
    starting: boolean;
    window: BrowserWindowInstance;
}

/** What the device window and the tray ask for. */
export interface TerminalOpener {
    availability: Availability;
    /** Opens a terminal for the folder, or asks for one when it is `null`. Rejects with the reason it cannot. */
    open: (folder: string | null) => Promise<void>;
}

export interface TerminalController extends TerminalOpener {
    /** The process ids of the shells running now. */
    pids: () => number[];
}

export interface TerminalOptions {
    /** Starts a host process. The default is an Electron utility process; tests pass a fake. */
    startHost?: () => HostHandle;
}

/** Sends the signal and says whether the process was there to receive it (`0` only checks). */
const signalled = (pid: number, signal: 0 | "SIGKILL"): boolean => {
    try {
        process.kill(pid, signal);

        return true;
    } catch {
        return false;
    }
};

/** How long the shells get to act on the hangup (save their history) before what is left is killed. */
const QUIT_GRACE_MS = 500;
const QUIT_POLL_MS = 20;
/** After this long without the process ending, a quit that began is taken to have been cancelled. */
const QUIT_RESET_MS = 5000;

/** Blocks, for at most the grace period, until none of the pids is alive. The app is on its way out. */
const waitForHangups = (pids: ReadonlySet<number>): void => {
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + QUIT_GRACE_MS;

    while (Date.now() < deadline && [...pids].some((pid) => signalled(pid, 0))) {
        Atomics.wait(pause, 0, 0, QUIT_POLL_MS);
    }
};

const forkHost = (): HostHandle => {
    const child = utilityProcess.fork(HOST_PATH, [], { serviceName: "Neore terminal host", stdio: "ignore" });

    return {
        kill: () => {
            child.kill();
        },
        onExit: (listener) => {
            child.once("exit", listener);
        },
        onMessage: (listener) => {
            child.on("message", (message: HostEvent) => listener(message));
        },
        post: (request: HostRequest) => {
            child.postMessage(request);
        },
    };
};

/** The terminal window may read its own files and nothing else; it asks for no permission and is given none. */
const lockDownSession = (ses: Session): void => {
    ses.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !details.url.startsWith("file://") });
    });
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
};

export const registerTerminalIpc = (options: TerminalOptions = {}): TerminalController => {
    const availability = terminalAvailability();
    const startHost = options.startHost ?? forkHost;
    const entries = new Map<WebContents, Entry>();
    const byFolder = new Map<string, Entry>();
    /** Every host not yet gone, so one still starting its shell is ended at quit as well. */
    const hosts = new Set<HostHandle>();
    /** The shells hung up at quit, checked once more at the very end. */
    const quitPids = new Set<number>();
    const pageUrl = pathToFileURL(TERMINAL_PAGE).href;
    let lockedDown = false;
    let quitting = false;
    let quitReset: ReturnType<typeof setTimeout> | undefined;

    const trackedHost = (): HostHandle => {
        const host = startHost();

        hosts.add(host);
        host.onExit(() => hosts.delete(host));

        return host;
    };

    const send = (target: WebContents, channel: string, payload?: unknown): void => {
        if (!target.isDestroyed()) {
            target.send(channel, payload);
        }
    };

    /** The page went away (a reload, a crash): its shell goes with it, and nothing it prints reaches the next page. */
    const endShell = (entry: Entry): void => {
        /* eslint-disable no-param-reassign -- an entry is this window's mutable record */
        entry.epoch += 1;
        entry.starting = false;
        entry.session?.kill();
        entry.session = undefined;
        /* eslint-enable no-param-reassign */
    };

    const openWindow = (cwd: string): void => {
        const existing = byFolder.get(cwd);

        if (existing !== undefined && !existing.closed) {
            if (existing.window.isMinimized()) {
                existing.window.restore();
            }

            existing.window.show();
            existing.window.focus();

            return;
        }

        if (!lockedDown) {
            lockDownSession(electronSession.fromPartition(PARTITION));
            lockedDown = true;
        }

        const window = new BrowserWindow({
            backgroundColor: "#1e1e1e",
            height: 520,
            minHeight: 240,
            minWidth: 360,
            // The path in the title says which folder this shell is in.
            title: `Terminal — ${cwd}`,
            webPreferences: {
                // A minimized window still acknowledges output; throttled timers would leave a busy shell paused.
                backgroundThrottling: false,
                contextIsolation: true,
                nodeIntegration: false,
                partition: PARTITION,
                preload: TERMINAL_PRELOAD,
                sandbox: true,
                webSecurity: true,
                webviewTag: false,
            },
            width: 780,
        });
        const { webContents } = window;
        const entry: Entry = { closed: false, cwd, epoch: 0, starting: false, window };

        entries.set(webContents, entry);
        byFolder.set(cwd, entry);

        webContents.setWindowOpenHandler(() => {
            return { action: "deny" };
        });
        // Same guards as every other local window: nothing moves it off its page.
        webContents.on("will-navigate", (event) => event.preventDefault());
        webContents.on("will-redirect", (event) => event.preventDefault());
        webContents.on("will-attach-webview", (event) => event.preventDefault());
        window.on("page-title-updated", (event) => event.preventDefault());
        // A reload (the default menu has one) does not pass through `will-navigate`, and the new page knows nothing of the old shell.
        webContents.on("did-start-loading", () => endShell(entry));
        webContents.on("render-process-gone", () => endShell(entry));
        window.on("closed", () => {
            // Closing the window ends its shell and drops everything it held.
            entry.closed = true;
            endShell(entry);
            entries.delete(webContents);

            if (byFolder.get(cwd) === entry) {
                byFolder.delete(cwd);
            }
        });
        window.loadFile(TERMINAL_PAGE);
    };

    const open = async (folder: string | null): Promise<void> => {
        if (!availability.available) {
            throw new Error(availability.reason);
        }

        if (folder !== null) {
            openWindow(readFolder(folder));

            return;
        }

        // Attached to the window the user clicked in: a parentless dialog can open behind an always-on-top one.
        const parent = BrowserWindow.getFocusedWindow();
        const pickerOptions = { properties: ["openDirectory" as const] };
        const result = parent === null ? await dialog.showOpenDialog(pickerOptions) : await dialog.showOpenDialog(parent, pickerOptions);
        const [picked] = result.filePaths;

        if (picked !== undefined && !result.canceled) {
            openWindow(readFolder(picked));
        }
    };

    /** The sender is a terminal window's own main frame, on our page. Returns its entry. */
    const entryOf = (event: IpcMainInvokeEvent): Entry => {
        const entry = entries.get(event.sender);

        if (
            entry === undefined
            || entry.closed
            || event.senderFrame === null
            || event.senderFrame !== event.sender.mainFrame
            || event.senderFrame.url !== pageUrl
        ) {
            throw new Error("terminal: not a terminal window");
        }

        return entry;
    };

    const handle = <Result>(channel: string, handler: (entry: Entry, ...args: unknown[]) => Result): void => {
        ipcMain.handle(channel, (event, ...args) => handler(entryOf(event), ...args));
    };

    const liveSession = (entry: Entry): TerminalSession => {
        if (entry.session === undefined) {
            throw new Error("terminal: no shell is running");
        }

        return entry.session;
    };

    /* eslint-disable no-param-reassign -- an entry is this window's mutable record; the handlers below are its only writers */
    handle(TERMINAL_CHANNEL.start, async (entry, size) => {
        const { cols, rows } = readSize(size);

        if (entry.session !== undefined || entry.starting) {
            throw new Error("terminal: a shell is already running");
        }

        const { epoch } = entry;
        let exited = false;

        entry.starting = true;

        try {
            const shell = resolveShell();
            const target = entry.window.webContents;
            const started = await startSession({
                onData: (data) => {
                    if (entry.epoch === epoch) {
                        send(target, TERMINAL_EVENT.data, data);
                    }
                },
                onExit: (info) => {
                    if (entry.epoch !== epoch) {
                        return;
                    }

                    exited = true;
                    entry.session = undefined;
                    send(target, TERMINAL_EVENT.exit, info);
                },
                spawn: { args: shell.args, cols, cwd: entry.cwd, env: shellEnvironment(), file: shell.file, rows },
                startHost: trackedHost,
            });

            if (quitting) {
                quitPids.add(started.pid);
                started.killNow();
            } else if (entry.closed || entry.epoch !== epoch) {
                started.kill();
            } else if (!exited) {
                // A shell that ended while the host was still reporting its start has already told the page.
                entry.session = started;
            }

            return { cwd: entry.cwd, shell: path.basename(shell.file) };
        } finally {
            if (entry.epoch === epoch) {
                entry.starting = false;
            }
        }
    });
    /* eslint-enable no-param-reassign */

    handle(TERMINAL_CHANNEL.input, (entry, data) => liveSession(entry).write(readInput(data)));

    handle(TERMINAL_CHANNEL.resize, (entry, size) => {
        const { cols, rows } = readSize(size);

        liveSession(entry).resize(cols, rows);
    });

    handle(TERMINAL_CHANNEL.ack, (entry, chars) => entry.session?.ack(readAck(chars)));

    // The page has no clipboard of its own (no permission, no `clipboard` module in a sandboxed preload).
    handle(TERMINAL_CHANNEL.copy, (_entry, text) => clipboard.writeText(readCopy(text)));

    handle(TERMINAL_CHANNEL.paste, () => clipboard.readText());

    // Quitting ends every shell the app started, before the app is gone. Electron closes the windows between
    // `before-quit` and `will-quit`, and a closing window forgets its entry, so the hangup goes out at `before-quit`.
    const hangUpAll = (): void => {
        quitting = true;
        // The page can still refuse to close (an unload guard), which cancels the quit without telling us:
        // a quit that has not ended the process by now was cancelled, and shells may start again.
        clearTimeout(quitReset);
        quitReset = setTimeout(() => {
            quitting = false;
            quitPids.clear();
        }, QUIT_RESET_MS);
        quitReset.unref();

        for (const { session } of entries.values()) {
            if (session === undefined) {
                continue;
            }

            quitPids.add(session.pid);

            session.killNow();
        }

        // A host still starting its shell has no session yet.
        for (const host of hosts) {
            host.kill();
        }
    };

    // A shell can ignore the hangup (`trap '' HUP`) and would outlive the app, so what is left at the end is killed.
    const finishQuit = (): void => {
        hangUpAll();
        waitForHangups(quitPids);

        for (const pid of quitPids) {
            if (signalled(pid, 0)) {
                signalled(pid, "SIGKILL");
            }
        }
    };

    app.on("before-quit", () => {
        // Only the shells of this attempt are signalled at the end: an id left from a cancelled one may be someone else's now.
        quitPids.clear();
        hangUpAll();
    });
    app.on("will-quit", finishQuit);

    return {
        availability,
        open,
        pids: () => {
            const pids: number[] = [];

            for (const entry of entries.values()) {
                if (entry.session !== undefined) {
                    pids.push(entry.session.pid);
                }
            }

            return pids;
        },
    };
};
