/**
 * The terminal host and session against a REAL pseudo-terminal: the bundle `scripts/build.mjs` makes is built
 * here and forked as a plain Node child (production starts the same file as an Electron utility process).
 * On Windows the shell is PowerShell on ConPTY and the cases are the same, in its syntax, except the two flow-control
 * cases: ConPTY re-renders what the shell prints, so a byte count through it says nothing about the pause mark.
 */
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { HostEvent, HostRequest } from "./protocol";
import type { HostHandle, TerminalSession } from "./session";
import { startSession } from "./session";
import { shellEnvironment } from "./shell";
import { makeSpawnHelperExecutable } from "./spawn-helper";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
// Inside node_modules so `require("node-pty")` resolves from the bundle, as it does from `dist/`.
const bundleDirectory = path.join(packageRoot, "node_modules", ".terminal-host-test");
const hostFile = path.join(bundleDirectory, "terminal-host.cjs");
const windows = process.platform === "win32";
const supported = process.platform === "darwin" || process.platform === "linux" || windows;
/** A cold PowerShell on a CI runner (antivirus scanning it, no profile cache) takes seconds to show its first prompt. */
const SHELL_WAIT_MS = windows ? 40_000 : 10_000;

/** The shell under test and the commands that mean the same thing in it. Windows PowerShell, without the user's profile, or `/bin/sh`. */
const dialect = windows
    ? {
        args: ["-NoLogo", "-NoProfile"],
        // A real child of the shell, which only a tree kill reaches. The typed text holds no digits after `child-`, so only the shell's answer matches.
        child: `$p = Start-Process -PassThru -NoNewWindow ping -ArgumentList '-n','1000','127.0.0.1'; echo "child-$($p.Id)"`,
        // The upper-cased path cannot be the prompt's (`PS C:\...>`), which already names the folder before any command runs.
        describe: "(Get-Location).Path.ToUpper(); echo marker-$(6*7)",
        enter: "\r",
        file: path.win32.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        folderShown: (folder: string) => path.basename(folder).toUpperCase(),
        missingFolder: String.raw`C:\definitely\not\a\folder`,
        // The typed text names no number, so only the shell's answer holds the width and height.
        size: `echo "size-$($Host.UI.RawUI.WindowSize.Width)x$($Host.UI.RawUI.WindowSize.Height)"`,
        // The typed text splits the word, so only the shell's answer holds it whole.
        unicode: `echo ("ä€" + "x")`,
    }
    : {
        args: [] as string[],
        // A foreground job: a shell does not pass a hangup on to its background jobs (dash does not), only to the one it is running.
        child: "sh -c 'echo child-$$; exec sleep 1000'",
        describe: "pwd; echo marker-$((6*7))",
        enter: "\n",
        file: "/bin/sh",
        // macOS resolves /var to /private/var, so only the folder's own name is compared.
        folderShown: (folder: string) => path.basename(folder),
        missingFolder: "/definitely/not/a/folder",
        size: "set -- $(stty size); echo size-$2x$1",
        unicode: "echo ä€''x",
    };

const CHILD_PID = /child-(\d+)/u;

const processes: ReturnType<typeof fork>[] = [];

const startHost = (): HostHandle => {
    const child = fork(hostFile, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });

    processes.push(child);

    return {
        kill: () => {
            child.kill("SIGKILL");
        },
        onExit: (listener) => {
            child.once("exit", listener);
        },
        onMessage: (listener) => {
            child.on("message", (message) => listener(message as HostEvent));
        },
        post: (request: HostRequest) => {
            child.send(request);
        },
    };
};

const isAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
};

const waitFor = async (condition: () => boolean, what: string, timeoutMs = SHELL_WAIT_MS): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }

        // eslint-disable-next-line no-await-in-loop -- polling
        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });
    }
};

interface Run {
    exits: { crashed: boolean; exitCode: number | null }[];
    output: () => string;
    session: TerminalSession;
}

const open = async (cwd: string, onChunk?: (chunk: string) => void): Promise<Run> => {
    let output = "";
    const exits: Run["exits"] = [];
    const session = await startSession({
        onData: (data) => {
            output += data;
            onChunk?.(data);
        },
        onExit: (info) => {
            exits.push(info);
        },
        spawn: { args: dialect.args, cols: 80, cwd, env: shellEnvironment(), file: dialect.file, rows: 24 },
        startHost,
    });

    return { exits, output: () => output, session };
};

beforeAll(() => {
    if (!supported) {
        return;
    }

    mkdirSync(bundleDirectory, { recursive: true });
    makeSpawnHelperExecutable(path.dirname(path.join(packageRoot, "node_modules", "node-pty", "package.json")));
    buildSync({
        bundle: true,
        entryPoints: [path.join(packageRoot, "src/terminal/host-main.ts")],
        external: ["node-pty"],
        format: "cjs",
        logLevel: "error",
        outfile: hostFile,
        platform: "node",
        target: "node22",
    });
});

afterAll(() => {
    for (const child of processes) {
        child.kill("SIGKILL");
    }

    rmSync(bundleDirectory, { force: true, recursive: true });
});

describe.skipIf(!supported)("terminal host (real pty)", { timeout: windows ? 120_000 : 60_000 }, () => {
    it("starts a shell in the folder and returns what it prints", async () => {
        const folder = mkdtempSync(path.join(tmpdir(), "neore-term-"));
        const run = await open(folder);

        run.session.write(`${dialect.describe}${dialect.enter}`);
        await waitFor(() => run.output().includes("marker-42"), "the shell's output");

        expect(run.output()).toContain(dialect.folderShown(folder));

        run.session.kill();
        await waitFor(() => run.exits.length > 0, "the shell to exit");
        rmSync(folder, { force: true, recursive: true });
    });

    it("reports a shell that cannot start, and ends the host", async () => {
        const exits: { crashed: boolean; exitCode: number | null }[] = [];
        let session: TerminalSession | undefined;

        try {
            session = await startSession({
                onData: () => {},
                onExit: (info) => {
                    exits.push(info);
                },
                spawn: { args: dialect.args, cols: 80, cwd: dialect.missingFolder, env: shellEnvironment(), file: dialect.file, rows: 24 },
                startHost,
            });
        } catch {
            // Refused at the start: reported below.
        }

        // A POSIX shell starts and exits with a failure; ConPTY refuses a missing folder when it creates the process.
        if (!windows) {
            expect(session).toBeDefined();
        }

        if (session !== undefined) {
            await waitFor(() => exits.length > 0, "the exit");
            expect(exits[0]?.exitCode).not.toBe(0);
            session.kill();
        }

        const [host] = processes.slice(-1);

        await waitFor(() => host?.exitCode !== null || host?.signalCode !== null, "the host to end");
    });

    it("ends the shell and a process it started when the session is killed", async () => {
        const run = await open(tmpdir());

        run.session.write(`${dialect.child}${dialect.enter}`);
        await waitFor(() => CHILD_PID.test(run.output()), "the child to start");

        const childPid = Number(CHILD_PID.exec(run.output())?.[1]);
        const shellPid = run.session.pid;

        expect(isAlive(shellPid)).toBe(true);
        expect(isAlive(childPid)).toBe(true);
        run.session.kill();
        await waitFor(() => !isAlive(shellPid), "the shell to end");
        await waitFor(() => !isAlive(childPid), "the child to end");
        await waitFor(() => run.exits.length > 0, "the exit to be reported");
        expect(run.exits).toHaveLength(1);
    });

    it("passes a resize on to the shell", async () => {
        const run = await open(tmpdir());

        run.session.resize(100, 30);
        run.session.write(`${dialect.size}${dialect.enter}`);
        await waitFor(() => run.output().includes("size-100x30"), "the shell to report its new size");
        expect(run.output()).toContain("size-100x30");
        run.session.kill();
    });

    it("carries non-ASCII text both ways", async () => {
        const run = await open(tmpdir());

        run.session.write(`${dialect.unicode}${dialect.enter}`);
        await waitFor(() => run.output().includes("ä€x"), "the shell to answer in the same characters");
        expect(run.output()).toContain("ä€x");
        run.session.kill();
    });

    it("ends the shell at once when the app quits (killNow)", async () => {
        const run = await open(tmpdir());
        const shellPid = run.session.pid;

        run.session.killNow();
        // The signal is sent before killNow returns; the process needs a moment to go.
        await waitFor(() => !isAlive(shellPid), "the shell to end");
        expect(isAlive(shellPid)).toBe(false);
    });

    it("leaves no shell behind when the host is killed without warning", async () => {
        const run = await open(tmpdir());
        const shellPid = run.session.pid;
        const [host] = processes.slice(-1);

        // Let the shell finish starting: a hangup before its first instruction is a race the quit path covers (`killNow`).
        await new Promise((resolve) => {
            setTimeout(resolve, 300);
        });

        host?.kill("SIGKILL");
        await waitFor(() => !isAlive(shellPid), "the shell to hang up");
        expect(isAlive(shellPid)).toBe(false);
    });

    // The pause mark is counted in what the pty hands over, and ConPTY re-renders the shell's output into its own
    // screen model first, so the same count of characters does not reach the host. Left to a separate measurement.
    it.skipIf(windows)("pauses a flooding shell until the window confirms the output, and resumes it", async () => {
        let chars = 0;
        const run = await open(tmpdir(), (chunk) => {
            chars += chunk.length;
        });

        run.session.write("yes | head -c 3000000; echo done-$((1+1))-flooding\n");
        // Nothing is acknowledged, so the flow must stall near the high watermark instead of growing without bound.
        await waitFor(() => chars > 400_000, "the first output");
        await new Promise((resolve) => {
            setTimeout(resolve, 500);
        });

        const stalledAt = chars;

        await new Promise((resolve) => {
            setTimeout(resolve, 500);
        });
        expect(chars).toBe(stalledAt);
        // 512 KiB high watermark, one in-flight batch (64 KiB) of slack, plus whatever the pty had already read.
        expect(stalledAt).toBeLessThan(1_000_000);

        // Acknowledging lets it run to the end.
        const ackTimer = setInterval(() => run.session.ack(chars), 10);

        await waitFor(() => run.output().includes("done-2-flooding"), "the flood to finish", 30_000);
        clearInterval(ackTimer);
        run.session.kill();
    });

    it.skipIf(windows)("moves heavy output at the rate of the pty itself", async () => {
        const total = 10_000_000;
        let chars = 0;
        const run = await open(tmpdir(), (chunk) => {
            chars += chunk.length;
            run.session.ack(chunk.length);
        });
        const started = performance.now();

        run.session.write(`yes | head -c ${String(total)}; echo done-$((1+1))-throughput\n`);
        await waitFor(() => run.output().includes("done-2-throughput"), "the output to finish", 60_000);

        const seconds = (performance.now() - started) / 1000;
        const megabytesPerSecond = chars / 1e6 / seconds;

        // eslint-disable-next-line no-console -- the measured rate is the point of this test
        console.info(`terminal throughput: ${String(Math.round(megabytesPerSecond))} MB/s over ${String(Math.round(chars / 1e6))} MB`);
        // The pty itself is the limit: node-pty alone moves `yes` at about 1-2 MB/s on macOS (it reads ~14 bytes per
        // chunk), and this path matches it. The floor only catches a stalled pipe, not a slow machine.
        expect(megabytesPerSecond).toBeGreaterThan(0.3);
        run.session.kill();
    });
});
