/**
 * One terminal as the main process sees it: a host child process (`host.ts`) with a shell on its
 * pseudo-terminal. Output is passed to `onData` and kept nowhere here; the counters below hold
 * numbers, not text.
 */
import { hangUp } from "./hang-up";
import type { HostEvent, HostRequest, SpawnRequest } from "./protocol";

/** The host process, however it was started (an Electron utility process; a plain fork in tests). */
export interface HostHandle {
    kill: () => void;
    onExit: (listener: () => void) => void;
    onMessage: (listener: (event: HostEvent) => void) => void;
    post: (request: HostRequest) => void;
}

/** The host has this long to report that the shell started. */
export const START_DEADLINE_MS = 5000;
/** Output the window has not confirmed writing. Above the high mark the shell is paused; at the low mark it resumes. */
export const HIGH_WATERMARK_CHARS = 512 * 1024;
export const LOW_WATERMARK_CHARS = 64 * 1024;
/** A host that has not gone this long after a hangup is killed. */
const FORCE_KILL_MS = 2000;

export interface ExitInfo {
    /** True when the host went away without reporting an exit: a crash, or a kill. */
    crashed: boolean;
    exitCode: number | null;
}

export interface SessionOptions {
    deadlineMs?: number;
    onData: (data: string) => void;
    onExit: (info: ExitInfo) => void;
    spawn: Omit<SpawnRequest, "type">;
    startHost: () => HostHandle;
}

export interface TerminalSession {
    /** Confirms that `chars` characters of output reached the window. */
    ack: (chars: number) => void;
    /** Hangs up the shell and ends the host. Safe to call twice. */
    kill: () => void;
    /** Like `kill`, but the shell is signalled (on Windows, its `taskkill` started) before this returns: for the app quitting. */
    killNow: () => void;
    readonly pid: number;
    resize: (cols: number, rows: number) => void;
    write: (data: string) => void;
}

export const startSession = (options: SessionOptions): Promise<TerminalSession> =>
    new Promise((resolve, reject) => {
        const host = options.startHost();
        let started = false;
        let settled = false;
        let ended = false;
        let hungUp = false;
        let paused = false;
        let unacked = 0;
        let pid = 0;
        let forceTimer: ReturnType<typeof setTimeout> | undefined;

        const end = (info: ExitInfo): void => {
            if (ended) {
                return;
            }

            ended = true;
            clearTimeout(forceTimer);

            if (started) {
                options.onExit(info);
            }
        };

        const fail = (message: string): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(deadline);
            host.kill();
            reject(new Error(message));
        };

        const deadline = setTimeout(fail, options.deadlineMs ?? START_DEADLINE_MS, "The terminal did not start in time.");

        const session: TerminalSession = {
            ack: (chars) => {
                unacked = Math.max(0, unacked - chars);

                if (!ended && paused && unacked <= LOW_WATERMARK_CHARS) {
                    paused = false;
                    host.post({ type: "resume" });
                }
            },
            kill: () => {
                if (ended) {
                    return;
                }

                host.post({ type: "kill" });
                forceTimer ??= setTimeout(() => host.kill(), FORCE_KILL_MS);
                forceTimer.unref();
            },
            killNow: () => {
                if (ended) {
                    return;
                }

                hungUp = true;
                hangUp(pid);
                host.post({ type: "kill" });
                host.kill();
            },
            get pid() {
                return pid;
            },
            resize: (cols, rows) => {
                if (!ended) {
                    host.post({ cols, rows, type: "resize" });
                }
            },
            write: (data) => {
                if (!ended) {
                    host.post({ data, type: "input" });
                }
            },
        };

        host.onMessage((event) => {
            switch (event.type) {
                case "data": {
                    if (started && !ended) {
                        unacked += event.data.length;
                        options.onData(event.data);

                        if (!paused && unacked >= HIGH_WATERMARK_CHARS) {
                            paused = true;
                            host.post({ type: "pause" });
                        }
                    }

                    break;
                }
                case "error": {
                    fail(event.message);
                    break;
                }
                case "exit": {
                    end({ crashed: false, exitCode: event.exitCode });
                    break;
                }
                case "started": {
                    if (!settled) {
                        settled = true;
                        started = true;
                        pid = event.pid;
                        clearTimeout(deadline);
                        resolve(session);
                    }

                    break;
                }
                default: {
                    break;
                }
            }
        });
        host.onExit(() => {
            // A POSIX shell hangs up when its pty closes with the host; a Windows one is left running by a host that died.
            // `killNow` has already hung it up, and its pid may belong to another process by now.
            if (started && !ended && !hungUp && process.platform === "win32") {
                hangUp(pid);
            }

            fail("The terminal host stopped before the shell started.");
            end({ crashed: true, exitCode: null });
        });
        host.post({ type: "spawn", ...options.spawn });
    });
