/**
 * Starting and stopping an agent process. The only way in is a `SpawnPlan` from the Rust core, which decided
 * the command, the folder and the environment; nothing here reads the app's own environment.
 *
 * Unix agents run in their own process group, so stopping one stops the shells and tools it started.
 * Windows is not supported yet (no job object, and `.cmd` shims need a shell): `acpSupported` is false there.
 *
 * An agent runs at a lower priority than the app, and on Linux is the first the kernel's out-of-memory killer takes:
 * a build or a test run an agent starts must not make the desktop sluggish, or cost the person the window.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getPriority, setPriority } from "node:os";
import type { Readable, Writable } from "node:stream";

import type { SpawnPlan } from "./types";

/** How long a polite stop waits before the group is killed. */
const TERM_GRACE_MS = 2000;

/** What is kept of an agent's stderr, for an error message. */
export const STDERR_KEEP_BYTES = 4096;
/** Secrets shorter than this are not worth scrubbing: they would garble ordinary text. */
export const MIN_SCRUBBED_LENGTH = 4;

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

/** Starts the agent `agentKey` as planned. The plan alone says what to run; the key tells a spawner that runs agents elsewhere which of its own to ask for. */
export type Spawner = (plan: SpawnPlan, agentKey: string) => AgentProcess;

/**
 * Replaces every occurrence of a variable the user set. Agents sometimes echo their environment. The built
 * variables (`HOME`, `PATH`, …) are not secrets and stay readable, or every path in a message would be garbled.
 */
export const scrub = (text: string, plan: SpawnPlan): string => {
    let result = text;

    for (const name of plan.secretNames) {
        const value = plan.env[name];

        if (value !== undefined && value.length >= MIN_SCRUBBED_LENGTH) {
            result = result.split(value).join("***");
        }
    }

    return result;
};

/** How much nicer than the app an agent runs: its niceness is the app's plus this, capped at {@link MAX_NICE}. */
export const AGENT_NICE_DELTA = 10;
export const MAX_NICE = 19;

/** How much the out-of-memory score (Linux, -1000 to 1000) of an agent is raised above the app's, which is never taken below 0. */
export const AGENT_OOM_SCORE_DELTA = 500;
export const MAX_OOM_SCORE_ADJ = 1000;

const NICE_PATH = "/usr/bin/nice";
const SH_PATH = "/bin/sh";
const OOM_SCORE_FILE = "/proc/self/oom_score_adj";

/** The niceness an agent gets when the app runs at `host`: lower than the app's, and never below it. */
export const agentNiceness = (host: number): number => Math.min(host + AGENT_NICE_DELTA, MAX_NICE);

/** The out-of-memory score an agent gets when the app has `host`: higher than the app's, and never below it. */
export const agentOomScoreAdj = (host: number): number => Math.min(Math.max(host, 0) + AGENT_OOM_SCORE_DELTA, MAX_OOM_SCORE_ADJ);

/** What the app itself runs with, and what the machine offers to start an agent already lowered. */
export interface HostPriority {
    readonly hasNice: boolean;
    readonly hasSh: boolean;
    readonly nice: number;
    readonly oomScoreAdj: number;
    readonly platform: NodeJS.Platform;
}

export interface AgentLaunch {
    readonly args: string[];
    readonly command: string;
    /** Still to do after the spawn because no wrapper could do it before: the agent is then unlowered for its first instants. */
    readonly lowerAfterSpawn: { readonly nice: boolean; readonly oomScoreAdj: boolean };
}

/**
 * The command that starts the agent already lowered, so nothing it forks in its first instants keeps full priority.
 * `nice -n DELTA` sets the niceness, and on Linux a `sh` writes the score into `/proc/self` and `exec`s on (same pid,
 * so the agent inherits it). The plan's command and arguments travel as separate argv entries, never through a shell
 * string. Without `nice` or `sh` the matching value is set after the spawn instead.
 */
export const agentLaunch = (plan: Pick<SpawnPlan, "args" | "command">, host: HostPriority): AgentLaunch => {
    let { args, command } = plan;
    const delta = agentNiceness(host.nice) - host.nice;
    const niceInline = host.hasNice && host.platform !== "win32";

    if (niceInline) {
        args = ["-n", String(delta), command, ...args];
        command = NICE_PATH;
    }

    const oomInline = host.platform === "linux" && host.hasSh;

    if (oomInline) {
        // A refused write (a read-only /proc) must not stop the agent: the score is only a preference.
        args = ["-c", `{ echo ${String(agentOomScoreAdj(host.oomScoreAdj))} > ${OOM_SCORE_FILE}; } 2>/dev/null; exec "$@"`, "sh", command, ...args];
        command = SH_PATH;
    }

    return { args, command, lowerAfterSpawn: { nice: !niceInline, oomScoreAdj: host.platform === "linux" && !oomInline } };
};

const readHostOomScoreAdj = (): number => {
    try {
        const value = Number(readFileSync(OOM_SCORE_FILE, "utf8").trim());

        return Number.isNaN(value) ? 0 : value;
    } catch {
        return 0;
    }
};

const hostPriority = (): HostPriority => {
    return {
        hasNice: existsSync(NICE_PATH),
        hasSh: existsSync(SH_PATH),
        nice: getPriority(0),
        oomScoreAdj: process.platform === "linux" ? readHostOomScoreAdj() : 0,
        platform: process.platform,
    };
};

/**
 * Lowers the priority of the agent `pid`, the leader of its group, for the parts {@link agentLaunch} could not do before
 * the start. Best effort — an agent at the normal priority is better than none, and `/proc` may be read-only in a
 * container. What it starts afterwards inherits both values.
 */
export const lowerAgentPriority = (pid: number, host: HostPriority, remaining: AgentLaunch["lowerAfterSpawn"]): void => {
    if (remaining.nice) {
        try {
            setPriority(pid, agentNiceness(host.nice));
        } catch {
            // The process is already gone, or the platform has no such call.
        }
    }

    if (remaining.oomScoreAdj) {
        try {
            writeFileSync(`/proc/${String(pid)}/oom_score_adj`, String(agentOomScoreAdj(host.oomScoreAdj)));
        } catch {
            // No /proc, or the agent ended in between.
        }
    }
};

/** Signals a whole process group. A group that is already gone (ESRCH) is the goal, not an error. */
const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
    try {
        process.kill(-pid, signal);
    } catch (error) {
        // macOS answers EPERM for a group whose only member is an exited leader not yet reaped: also gone, and the
        // agent now starts through `nice`, which makes a command that cannot run end that way within milliseconds.
        const { code } = error as NodeJS.ErrnoException;

        if (code !== "ESRCH" && code !== "EPERM") {
            throw error;
        }
    }
};

export const spawnAgent: Spawner = (plan) => {
    if (!acpSupported) {
        throw new Error("coding agents are not supported on Windows yet");
    }

    let child: ChildProcess;
    const host = hostPriority();
    const launch = agentLaunch(plan, host);

    try {
        child = spawn(launch.command, launch.args, {
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

    if (child.pid !== undefined && (launch.lowerAfterSpawn.nice || launch.lowerAfterSpawn.oomScoreAdj)) {
        lowerAgentPriority(child.pid, host, launch.lowerAfterSpawn);
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
