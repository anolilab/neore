/**
 * Best-effort behaviour of the agent process: a machine that will not report the app's priority still starts the
 * agent, and a denied signal to a living group is reported rather than taken for "gone".
 */
import { getPriority } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentProcess } from "./process";
import { spawnAgent } from "./process";
import type { SpawnPlan } from "./types";

vi.mock(import("node:os"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, default: { ...actual.default, getPriority: vi.fn(actual.getPriority) }, getPriority: vi.fn(actual.getPriority) };
});

const SLEEP = /sleep$/;

const plan = (): SpawnPlan => {
    return { args: ["30"], command: "sleep", cwd: process.cwd(), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, scratch: false, secretNames: [] };
};

let agent: AgentProcess | undefined;

afterEach(() => {
    vi.restoreAllMocks();
    agent?.killNow();
    agent = undefined;
});

const eperm = (): NodeJS.ErrnoException => Object.assign(new Error("kill EPERM"), { code: "EPERM" });

describe.skipIf(process.platform === "win32")("an agent on a machine that denies the priority query", () => {
    it("still starts, unwrapped", async () => {
        vi.mocked(getPriority).mockImplementation(() => {
            throw eperm();
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        agent = spawnAgent(plan(), "claude");

        expect(agent.pid).toBeDefined();
        // Not wrapped in `nice` or `sh`: the process is the command itself, once it has exec'd (a moment after the spawn).
        const { execFileSync } = await import("node:child_process");
        const pid = String(agent.pid);

        await vi.waitFor(() => {
            expect(execFileSync("ps", ["-o", "comm=", "-p", pid], { encoding: "utf8" }).trim()).toMatch(SLEEP);
        });
        expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    });
});

describe.skipIf(process.platform === "win32")("a denied signal to the group", () => {
    const denyGroupSignals = () => {
        const real = process.kill.bind(process);

        vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
            if (pid < 0) {
                throw eperm();
            }

            return real(pid, signal);
        }) as typeof process.kill);
    };

    it("is NOT taken for a gone group while the leader is alive: stop() reports it", async () => {
        agent = spawnAgent(plan(), "claude");
        denyGroupSignals();

        await expect(agent.stop()).rejects.toMatchObject({ code: "EPERM" });
    });

    it("is reported by killNow without throwing", () => {
        agent = spawnAgent(plan(), "claude");
        denyGroupSignals();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        expect(() => agent?.killNow()).not.toThrow();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("may remain"));
    });

    it("is still taken for gone once the leader has exited", async () => {
        agent = spawnAgent({ ...plan(), args: ["0"] }, "claude");
        await agent.exited;
        denyGroupSignals();

        await expect(agent.stop()).resolves.toBeUndefined();
        expect(() => agent?.killNow()).not.toThrow();
    });
});
