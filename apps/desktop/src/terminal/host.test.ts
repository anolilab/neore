/**
 * The terminal host and session against a REAL pseudo-terminal: the bundle `scripts/build.mjs` makes is built
 * here and forked as a plain Node child (production starts the same file as an Electron utility process).
 * macOS and Linux only; Windows has no terminal yet.
 */
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const supported = process.platform === "darwin" || process.platform === "linux";

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

const waitFor = async (condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> => {
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

const open = async (cwd: string, shellArguments: string[], onChunk?: (chunk: string) => void): Promise<Run> => {
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
        spawn: { args: shellArguments, cols: 80, cwd, env: shellEnvironment(), file: "/bin/sh", rows: 24 },
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

describe.skipIf(!supported)("terminal host (real pty)", { timeout: 60_000 }, () => {
    it("starts a shell in the folder and returns what it prints", async () => {
        const folder = mkdtempSync(path.join(tmpdir(), "neore-term-"));
        const run = await open(folder, []);

        run.session.write("pwd; echo marker-$((6*7))\n");
        await waitFor(() => run.output().includes("marker-42"), "the shell's output");

        // macOS resolves /var to /private/var, so only the folder's own name is compared.
        expect(run.output()).toContain(path.basename(folder));

        run.session.kill();
        await waitFor(() => run.exits.length > 0, "the shell to exit");
        rmSync(folder, { force: true, recursive: true });
    });

    it("reports a shell that cannot start as an exit, and ends the host", async () => {
        const exits: { crashed: boolean; exitCode: number | null }[] = [];
        const session = await startSession({
            onData: () => {},
            onExit: (info) => {
                exits.push(info);
            },
            spawn: { args: [], cols: 80, cwd: "/definitely/not/a/folder", env: shellEnvironment(), file: "/bin/sh", rows: 24 },
            startHost,
        });

        await waitFor(() => exits.length > 0, "the exit");
        expect(exits[0]?.exitCode).not.toBe(0);
        session.kill();
    });

    it("ends the shell and its foreground job when the session is killed", async () => {
        const run = await open(tmpdir(), []);

        run.session.write("sleep 1000\n");
        await new Promise((resolve) => {
            setTimeout(resolve, 300);
        });

        const shellPid = run.session.pid;

        expect(isAlive(shellPid)).toBe(true);
        run.session.kill();
        await waitFor(() => !isAlive(shellPid), "the shell to end");
        expect(run.exits).toHaveLength(1);
    });

    it("ends a foreground job that ignores the hangup along with the shell", async () => {
        const run = await open(tmpdir(), []);
        const jobDirectory = mkdtempSync(path.join(tmpdir(), "neore-job-"));
        const pidFile = path.join(jobDirectory, "job.pid");

        // `exec` keeps the ignored hangup: the job outlives anything that only signals the shell.
        run.session.write(`sh -c 'trap "" HUP; echo $$ > ${pidFile}; exec sleep 1000'\n`);
        const recorded = (): string => existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";

        await waitFor(() => recorded() !== "", "the job to start");

        const jobPid = Number(recorded());

        expect(isAlive(jobPid)).toBe(true);
        run.session.kill();
        await waitFor(() => !isAlive(jobPid), "the job to end", 15_000);
        rmSync(jobDirectory, { force: true, recursive: true });
    });

    it("ends the shell at once when the app quits (killNow)", async () => {
        const run = await open(tmpdir(), []);
        const shellPid = run.session.pid;

        run.session.killNow();
        // The signal is sent before killNow returns; the process needs a moment to go.
        await waitFor(() => !isAlive(shellPid), "the shell to end");
        expect(isAlive(shellPid)).toBe(false);
    });

    it("leaves no shell behind when the host is killed without warning", async () => {
        const run = await open(tmpdir(), []);
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

    it("pauses a flooding shell until the window confirms the output, and resumes it", async () => {
        let chars = 0;
        const run = await open(tmpdir(), [], (chunk) => {
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

    it("moves heavy output at the rate of the pty itself", async () => {
        const total = 10_000_000;
        let chars = 0;
        const run = await open(tmpdir(), [], (chunk) => {
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
