/**
 * The terminal host: a child process that owns one pseudo-terminal and the shell on it. The native
 * PTY code lives here, not in the main process, so a crash in it ends one terminal and not the app.
 * The main process starts it with a deadline and kills it with its terminal (`session.ts`).
 *
 * Everything the shell prints crosses to the main process as `data` events and is held nowhere here
 * beyond the batch being sent. Output is paused at the pty when the main process says the window
 * cannot keep up, so a runaway `yes` fills the kernel's buffer and not this process's memory.
 */
import { descendantsOf, killAll } from "./kill-session";
import type { HostEvent, HostRequest, SpawnRequest } from "./protocol";

export interface HostTransport {
    /** Called once when the channel to the main process closes. */
    onClose: (listener: () => void) => void;
    onMessage: (listener: (request: HostRequest) => void) => void;
    post: (event: HostEvent) => void;
}

/** The slice of `node-pty` this file uses. */
export interface Pty {
    kill: (signal?: string) => void;
    onData: (listener: (data: string) => void) => void;
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => void;
    pause: () => void;
    pid: number;
    resize: (cols: number, rows: number) => void;
    resume: () => void;
    write: (data: string) => void;
}

export interface PtyModule {
    spawn: (file: string, args: string[], options: { cols: number; cwd: string; encoding: string; env: Record<string, string>; name: string; rows: number }) => Pty;
}

/** Output is sent in batches: one message per chunk would cost more than the shell's output itself. */
const FLUSH_INTERVAL_MS = 8;
const FLUSH_CHARS = 64 * 1024;
/** After a hangup the shell gets this long before it is killed outright. */
const KILL_GRACE_MS = 1000;
const EXIT_DELAY_MS = 50;

export const runHost = (transport: HostTransport, loadPty: () => PtyModule, prepare: () => void = () => {}): void => {
    let term: Pty | undefined;
    let ended = false;
    let pending = "";
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    /** The shell's descendants when it was told to stop: a job that ignored the hangup is killed with the host. */
    let jobs: number[] = [];

    const flush = (): void => {
        clearTimeout(flushTimer);
        flushTimer = undefined;

        if (pending.length > 0) {
            const data = pending;

            pending = "";
            transport.post({ data, type: "data" });
        }
    };

    const finish = (): void => {
        flush();
        killAll(jobs);
        // Gives the last messages time to reach the main process before this one goes away.
        // eslint-disable-next-line unicorn/no-process-exit -- this process exists for one shell and ends with it
        setTimeout(() => process.exit(0), EXIT_DELAY_MS);
    };

    /** Hangs up the shell, then kills it if it ignored that. Safe to call twice. */
    const stop = (): void => {
        if (term === undefined || ended) {
            finish();

            return;
        }

        const { pid } = term;

        // Taken before the hangup: a job that ignores it outlives the shell and is no longer found through it.
        jobs = descendantsOf(pid);

        try {
            term.kill("SIGHUP");
        } catch {
            // Already gone.
        }

        setTimeout(() => {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                // Already gone.
            }

            finish();
        }, KILL_GRACE_MS).unref();
    };

    const spawn = (request: SpawnRequest): void => {
        if (term !== undefined) {
            transport.post({ message: "terminal: already started", type: "error" });

            return;
        }

        try {
            prepare();

            const started = loadPty().spawn(request.file, request.args, {
                cols: request.cols,
                cwd: request.cwd,
                encoding: "utf8",
                env: request.env,
                name: "xterm-256color",
                rows: request.rows,
            });

            term = started;
            started.onData((data) => {
                pending += data;

                if (pending.length >= FLUSH_CHARS) {
                    flush();
                } else {
                    flushTimer ??= setTimeout(flush, FLUSH_INTERVAL_MS);
                }
            });
            started.onExit(({ exitCode, signal }) => {
                ended = true;
                flush();
                transport.post({ exitCode, signal: signal ?? 0, type: "exit" });
                finish();
            });
            transport.post({ pid: started.pid, type: "started" });
        } catch (error) {
            transport.post({ message: error instanceof Error ? error.message : String(error), type: "error" });
            finish();
        }
    };

    transport.onMessage((request) => {
        switch (request.type) {
            case "input": {
                term?.write(request.data);
                break;
            }
            case "kill": {
                stop();
                break;
            }
            case "pause": {
                term?.pause();
                break;
            }
            case "resize": {
                try {
                    term?.resize(request.cols, request.rows);
                } catch {
                    // The shell is exiting.
                }

                break;
            }
            case "resume": {
                term?.resume();
                break;
            }
            case "spawn": {
                spawn(request);
                break;
            }
            default: {
                break;
            }
        }
    });

    // The app going away, however it goes, takes the shell with it.
    transport.onClose(stop);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", stop);

    const parent = process.ppid;

    setInterval(() => {
        if (process.ppid !== parent) {
            stop();
        }
    }, 2000).unref();
};
