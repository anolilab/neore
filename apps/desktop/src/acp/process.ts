/**
 * Starting and stopping an agent process. The only way in is a `SpawnPlan` from the Rust core, which decided
 * the command, the folder and the environment; nothing here reads the app's own environment.
 *
 * Unix agents run in their own process group, so stopping one stops the shells and tools it started.
 * Windows is not supported yet (no job object, and `.cmd` shims need a shell): `acpSupported` is false there.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { SpawnPlan } from "./types";

/** How long a polite stop waits before the group is killed. */
const TERM_GRACE_MS = 2000;
/** What is kept of an agent's stderr, for an error message. */
const STDERR_KEEP_BYTES = 4096;
/** Secrets shorter than this are not worth scrubbing: they would garble ordinary text. */
const MIN_SCRUBBED_LENGTH = 4;

export const acpSupported = process.platform !== "win32";

export interface AgentProcess {
    readonly exited: Promise<{ code: number | null; signal: string | null }>;
    /** SIGKILL to the group, now and without waiting (the app is quitting). */
    killNow: () => void;
    readonly pid: number | undefined;
    /** The text with the values of the variables the user set replaced: safe to put in an error or show in the window. */
    scrub: (text: string) => string;
    /** Length of the longest value `scrub` replaces; 0 when it replaces nothing. A value split across two chunks of text is caught by holding back this much of the tail. */
    readonly secretLength: number;
    stderrTail: () => string;
    readonly stdin: Writable;
    readonly stdout: Readable;
    /** SIGTERM to the group, then SIGKILL after a grace period. Resolves once the process has exited. */
    stop: () => Promise<void>;
}

export type Spawner = (plan: SpawnPlan) => AgentProcess;

/**
 * Replaces every occurrence of a variable the user set. Agents sometimes echo their environment. The built
 * variables (`HOME`, `PATH`, …) are not secrets and stay readable, or every path in a message would be garbled.
 */
const scrub = (text: string, plan: SpawnPlan): string => {
    let result = text;

    for (const name of plan.secretNames) {
        const value = plan.env[name];

        if (value !== undefined && value.length >= MIN_SCRUBBED_LENGTH) {
            result = result.split(value).join("***");
        }
    }

    return result;
};

/** Signals a whole process group. A group that is already gone (ESRCH) is the goal, not an error. */
const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
    try {
        process.kill(-pid, signal);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
        }
    }
};

export const spawnAgent: Spawner = (plan) => {
    if (!acpSupported) {
        throw new Error("coding agents are not supported on Windows yet");
    }

    let child: ChildProcess;

    try {
        child = spawn(plan.command, plan.args, {
            cwd: plan.cwd,
            detached: true,
            // Not inherited: the plan's environment is the whole environment.
            env: plan.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
    } catch (error) {
        // Node names the offending value in some argument errors; say what failed, not what it held. The error
        // itself is not kept as a cause for the same reason.
        // eslint-disable-next-line preserve-caught-error -- the cause can quote an environment value
        throw new Error(`could not start ${plan.command}: ${scrub((error as Error).message, plan)}`);
    }

    let stderr = "";

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
        // Scrubbed before it is cut, so a cut cannot leave the tail of a value that the scrub would no longer match.
        stderr = scrub(stderr + chunk, plan).slice(-STDERR_KEEP_BYTES);
    });

    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        // `error` is a failed spawn (ENOENT, EACCES): the process never ran.
        child.once("error", (error) => {
            stderr = scrub(`${stderr}${error.message}`, plan).slice(-STDERR_KEEP_BYTES);
            resolve({ code: null, signal: null });
        });
        child.once("exit", (code, signal) => {
            // The leader is gone, and a crash leaves its shells and tools running in the group. They go with it.
            if (child.pid !== undefined) {
                try {
                    signalGroup(child.pid, "SIGKILL");
                } catch {
                    // Nothing more can be done for a group we may not signal.
                }
            }

            resolve({ code, signal });
        });
    });

    // Without a listener a failed spawn would be an uncaught exception.
    child.on("error", () => {});
    child.stdin?.on("error", () => {});

    const stop = async (): Promise<void> => {
        const { pid } = child;

        if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
            return;
        }

        signalGroup(pid, "SIGTERM");

        const timer = setTimeout(() => {
            try {
                signalGroup(pid, "SIGKILL");
            } catch {
                // A group we may not signal cannot be helped from a timer; the exit below still ends the wait.
            }
        }, TERM_GRACE_MS);

        await exited;
        clearTimeout(timer);
        // The leader is gone; anything it left behind in the group goes too.
        signalGroup(pid, "SIGKILL");
    };

    return {
        exited,
        killNow: () => {
            if (child.pid !== undefined) {
                signalGroup(child.pid, "SIGKILL");
            }
        },
        pid: child.pid,
        scrub: (text) => scrub(text, plan),
        secretLength: Math.max(0, ...plan.secretNames.map((name) => plan.env[name]?.length ?? 0).filter((length) => length >= MIN_SCRUBBED_LENGTH)),
        stderrTail: () => scrub(stderr, plan),
        stdin: child.stdin as Writable,
        stdout: child.stdout as Readable,
        stop,
    };
};
