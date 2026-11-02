/**
 * An agent starts at a lower priority than the app that started it, and on Linux with an out-of-memory score that
 * makes the kernel take it first. The app itself, and anything else it runs, keeps its own.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getPriority } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentProcess, HostPriority } from "./process";
import { agentLaunch, agentNiceness, agentOomScoreAdj, spawnAgent } from "./process";
import type { SpawnPlan } from "./types";

const plan = (): SpawnPlan => {
    return { args: ["30"], command: "sleep", cwd: process.cwd(), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, scratch: false, secretNames: [] };
};

let agent: AgentProcess | undefined;

afterEach(async () => {
    // A group whose members are all gone can answer EPERM on some systems; the process is dead either way.
    try {
        await agent?.stop();
    } catch {
        // Dead either way.
    }

    agent = undefined;
});

describe.skipIf(process.platform === "win32")("the priority of a spawned agent", () => {
    it("is lower than the app's, which keeps its own", async () => {
        const own = getPriority(0);

        agent = spawnAgent(plan(), "claude");

        expect(agent.pid).toBeDefined();
        const { pid } = agent;

        // The wrapper `nice` has to run before the agent does, so the value is there a moment after the spawn.
        await vi.waitFor(() => {
            expect(getPriority(pid as number)).toBe(agentNiceness(own));
        });
        expect(getPriority(agent.pid as number)).toBeGreaterThan(own);
        expect(getPriority(0)).toBe(own);
    });

    it("is inherited by what the agent starts", async () => {
        agent = spawnAgent({ ...plan(), args: ["-c", "sleep 10 & echo $!; wait"], command: "sh" }, "claude");

        const grandchild = await new Promise<number>((resolve) => {
            agent?.stdout.once("data", (chunk: Buffer) => {
                resolve(Number(chunk.toString().trim()));
            });
        });

        expect(getPriority(grandchild)).toBeGreaterThan(getPriority(0));
    });
});

/** Whether the score can be written: it is read-only in some containers, and writing the current value back tells. */
const oomScoreWritable = (): boolean => {
    if (process.platform !== "linux") {
        return false;
    }

    try {
        writeFileSync("/proc/self/oom_score_adj", readFileSync("/proc/self/oom_score_adj", "utf8").trim());

        return true;
    } catch {
        return false;
    }
};

describe("the priority an agent gets relative to the app", () => {
    it("is 10 nicer than the app, capped at 19, and never nicer-lower than the app", () => {
        expect(agentNiceness(0)).toBe(10);
        expect(agentNiceness(5)).toBe(15);
        expect(agentNiceness(15)).toBe(19);
        expect(agentNiceness(19)).toBe(19);
    });

    it("raises the out-of-memory score by 500 over the app's, from 0 at least, capped at 1000", () => {
        expect(agentOomScoreAdj(0)).toBe(500);
        expect(agentOomScoreAdj(-300)).toBe(500);
        expect(agentOomScoreAdj(400)).toBe(900);
        expect(agentOomScoreAdj(800)).toBe(1000);
        expect(agentOomScoreAdj(1000)).toBe(1000);
    });
});

describe("how an agent is started", () => {
    const host = (overrides: Partial<HostPriority> = {}): HostPriority => {
        return { hasNice: true, hasSh: true, nice: 4, oomScoreAdj: 200, platform: "linux", ...overrides };
    };
    const target = { args: ["--flag", "a b; rm -rf /"], command: "claude" };

    it("starts already lowered on Linux: sh writes the score, then nice runs the command with its arguments as separate argv entries", () => {
        const launch = agentLaunch(target, host());

        expect(launch.command).toBe("/bin/sh");
        expect(launch.args.slice(2)).toEqual(["sh", "/usr/bin/nice", "-n", "10", "claude", "--flag", "a b; rm -rf /"]);
        expect(launch.args[1]).toContain("echo 700 > /proc/self/oom_score_adj");
        expect(launch.args[1]).toContain("exec \"$@\"");
        expect(launch.args[1]).not.toContain("claude");
        expect(launch.lowerAfterSpawn).toEqual({ nice: false, oomScoreAdj: false });
    });

    it("starts through nice alone on macOS", () => {
        const launch = agentLaunch(target, host({ platform: "darwin" }));

        expect(launch).toEqual({ args: ["-n", "10", "claude", "--flag", "a b; rm -rf /"], command: "/usr/bin/nice", lowerAfterSpawn: { nice: false, oomScoreAdj: false } });
    });

    it("asks nice for only what is left when the app is already near the cap", () => {
        expect(agentLaunch(target, host({ nice: 15, platform: "darwin" })).args.slice(0, 2)).toEqual(["-n", "4"]);
        expect(agentLaunch(target, host({ nice: 19, platform: "darwin" })).args.slice(0, 2)).toEqual(["-n", "0"]);
    });

    it("falls back to lowering after the spawn for what has no wrapper", () => {
        expect(agentLaunch(target, host({ hasNice: false, hasSh: false }))).toEqual({ args: target.args, command: "claude", lowerAfterSpawn: { nice: true, oomScoreAdj: true } });
        expect(agentLaunch(target, host({ hasNice: false, platform: "darwin" })).lowerAfterSpawn).toEqual({ nice: true, oomScoreAdj: false });
    });
});

describe.skipIf(!oomScoreWritable())("the out-of-memory score of a spawned agent", () => {
    it("is raised for the agent and left alone for the app", async () => {
        const own = readFileSync("/proc/self/oom_score_adj", "utf8").trim();

        agent = spawnAgent(plan(), "claude");

        const { pid } = agent;
        const expected = String(agentOomScoreAdj(Number(own)));

        // The wrapper `sh` writes the score before it execs the agent, so it is there a moment after the spawn.
        await vi.waitFor(() => {
            expect(readFileSync(`/proc/${String(pid)}/oom_score_adj`, "utf8").trim()).toBe(expected);
        });
        expect(readFileSync("/proc/self/oom_score_adj", "utf8").trim()).toBe(own);
    });
});
