/**
 * An agent starts at a lower priority than the app that started it, and on Linux with an out-of-memory score that
 * makes the kernel take it first. The app itself, and anything else it runs, keeps its own.
 */
import { readFileSync } from "node:fs";
import { getPriority } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentProcess } from "./process";
import { AGENT_NICE, AGENT_OOM_SCORE_ADJ, spawnAgent } from "./process";
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
    it("is lower than the app's, which keeps its own", () => {
        const own = getPriority(0);

        agent = spawnAgent(plan(), "claude");

        expect(agent.pid).toBeDefined();
        expect(getPriority(agent.pid as number)).toBe(Math.max(own, AGENT_NICE));
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

describe.skipIf(process.platform !== "linux")("the out-of-memory score of a spawned agent", () => {
    it("is raised for the agent and left alone for the app", () => {
        const own = readFileSync("/proc/self/oom_score_adj", "utf8").trim();

        agent = spawnAgent(plan(), "claude");

        const adjusted = readFileSync(`/proc/${String(agent.pid)}/oom_score_adj`, "utf8").trim();

        const after = readFileSync("/proc/self/oom_score_adj", "utf8").trim();
        const expected = String(Math.max(Number(own), AGENT_OOM_SCORE_ADJ));

        expect(adjusted).toBe(expected);
        expect(after).toBe(own);
    });
});
