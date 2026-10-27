/**
 * The manager against a real scripted agent process (`testing/fake-agent.mjs`), which checks every frame the
 * host writes against the SDK's schema and the protocol's ordering and logs any violation. Each test ends by
 * asserting there were none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AcpManager } from "./manager";
import { spawnAgent } from "./process";
import { alive, expectGone, Scratch } from "./testing/harness";
import type { SessionSnapshot, SpawnPlan } from "./types";

const SENTINEL = "sentinel-secret-7f3a";
const PID_PREFIX = /^pid:\d+/u;
const PID = /pid:(\d+)/u;
const PID_AND_AGENT = /pid:(\d+) agent:(\d+)/u;
const MISSING_COMMAND = /ENOENT|closed its output|exited/u;

let scratch: Scratch;
let manager: AcpManager;
const plans: { env: Record<string, string>; folder: string | null; key: string }[] = [];

const make = (env: Record<string, string> = {}, options: { cancelGraceMs?: number; plan?: (key: string, folder: string | null) => SpawnPlan } = {}): AcpManager => new AcpManager({
    appVersion: "9.9.9",
    cancelGraceMs: options.cancelGraceMs ?? 400,
    onChange: () => {},
    plan:
            options.plan
            ?? ((key, folder) => {
                const plan = scratch.plan(env, folder);

                plans.push({ env: plan.env, folder, key });

                return plan;
            }),
    spawn: spawnAgent,
    startupTimeoutMs: 8000,
});

const start = (target: AcpManager = manager): Promise<string> => target.startSession("fake", "Fake", scratch.work);

/** The message of a rejection, or "" when it did not reject. */
const messageOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
        await promise;

        return "";
    } catch (error) {
        return (error as Error).message;
    }
};

const snapshot = (id: string, target: AcpManager = manager): SessionSnapshot => target.snapshot(id);

const idle = (id: string, target: AcpManager = manager) => expect.poll(() => snapshot(id, target).status, { timeout: 8000 }).toBe("idle");

beforeEach(() => {
    scratch = new Scratch();
    plans.length = 0;
    manager = make();
});

afterEach(() => {
    manager.killAll();
    scratch.dispose();
    vi.restoreAllMocks();
});

describe("a session", () => {
    it("answers a prompt", async () => {
        const id = await start();

        manager.send(id, "hello");
        await idle(id);

        expect(snapshot(id).turns[0]).toMatchObject({ stopReason: "end_turn", text: "Hello world", user: "hello" });
        expect(scratch.violations()).toEqual([]);
        // The host advertises no file system and no terminal.
        const init = scratch.log().find((entry) => entry.received?.method === "initialize");

        expect(init?.received?.params).toMatchObject({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, protocolVersion: 1 });
        expect(scratch.log().find((entry) => entry.sessionNew !== undefined)?.sessionNew).toEqual({ cwd: scratch.work, mcpServers: [] });
    });

    it("queues a prompt sent while busy and sends it after the first ends, in order", async () => {
        const id = await start();

        manager.send(id, "slow");
        expect(manager.send(id, "echo second")).toEqual({ position: 1, status: "queued" });
        expect(manager.send(id, "echo third")).toEqual({ position: 2, status: "queued" });
        await expect.poll(() => snapshot(id).turns.length, { timeout: 8000 }).toBe(3);
        await idle(id);

        expect(snapshot(id).turns.map((turn) => turn.text)).toEqual(["working", "second", "third"]);
        expect(scratch.log().flatMap((entry) => entry.prompt === undefined ? [] : [entry.prompt])).toEqual(["slow", "echo second", "echo third"]);
        expect(scratch.violations()).toEqual([]);
    });

    it("refuses, rather than drops, a prompt when the queue is full", async () => {
        const id = await start();

        manager.send(id, "hang");

        for (let i = 0; i < 8; i += 1) {
            manager.send(id, `echo ${String(i)}`);
        }

        expect(() => manager.send(id, "echo overflow")).toThrow("already waiting");
        expect(snapshot(id).queued).toHaveLength(8);
    });

    it("ends every open tool call and the queue on cancel, and a late update cannot revive a call", async () => {
        const target = make({ FAKE_AGENT_LATE_TOOL: "1" });
        const id = await start(target);

        target.send(id, "tool");
        await expect.poll(() => snapshot(id, target).turns[0]?.tools[0]?.status).toBe("in_progress");
        target.send(id, "echo never");
        target.cancel(id);

        expect(snapshot(id, target).queued).toEqual([]);
        expect(snapshot(id, target).turns[0].tools[0].status).toBe("cancelled");

        await idle(id, target);

        const finished = snapshot(id, target);

        expect(finished.turns).toHaveLength(1);
        expect(finished.turns[0]).toMatchObject({ stopReason: "cancelled" });
        // The agent sent `in_progress` for the call after the cancel: it stays cancelled.
        expect(finished.turns[0].tools.map((tool) => tool.status)).toEqual(["cancelled"]);
        // Stop released nothing later.
        expect(scratch.log().flatMap((entry) => entry.prompt === undefined ? [] : [entry.prompt])).toEqual(["tool"]);
        expect(scratch.log().filter((entry) => entry.cancel !== undefined)).toHaveLength(1);
        expect(scratch.violations()).toEqual([]);
        target.killAll();
    });

    it("ends an agent that ignores a cancel, killing its tools with it", async () => {
        const target = make({ FAKE_AGENT_IGNORE_CANCEL: "1" }, { cancelGraceMs: 200 });
        const id = await start(target);

        target.send(id, "child");
        await expect.poll(() => snapshot(id, target).turns[0]?.text, { timeout: 8000 }).toMatch(PID_PREFIX);

        const pid = Number(PID.exec(snapshot(id, target).turns[0].text)?.[1]);

        expect(alive(pid)).toBe(true);
        target.cancel(id);
        await expect.poll(() => snapshot(id, target).status, { timeout: 8000 }).toBe("ended");

        expect(snapshot(id, target).endReason).toContain("did not stop");
        expect(snapshot(id, target).turns[0].tools.every((tool) => tool.status === "cancelled")).toBe(true);
        await expectGone(pid);
    });
});

describe("the end of a turn, with a real process", () => {
    it("holds a queued prompt until the response, even when the work looks finished earlier", async () => {
        const id = await start();

        manager.send(id, "early");
        await expect.poll(() => snapshot(id).turns[0]?.tools[0]?.status).toBe("completed");
        manager.send(id, "echo after");
        await idle(id);
        await expect.poll(() => snapshot(id).turns.length).toBe(2);
        await idle(id);

        expect(snapshot(id).turns.map((turn) => turn.text)).toEqual(["all done", "after"]);
        // The fake agent records a violation for a second prompt while one is running.
        expect(scratch.violations()).toEqual([]);
    });

    it("keeps an idle session idle when updates trail the response", async () => {
        const id = await start();

        manager.send(id, "late");
        await idle(id);
        await expect.poll(() => snapshot(id).turns[0].text, { timeout: 8000 }).toBe(" (late)");

        expect(snapshot(id).status).toBe("idle");
        expect(snapshot(id).turns[0].tools[0].status).toBe("completed");
        expect(scratch.violations()).toEqual([]);
    });
});

describe("a version probe", () => {
    it("reads the handshake and opens no session", async () => {
        const result = await manager.probe("fake");

        expect(result).toEqual({ agentName: "Fake Agent", agentVersion: "1.2.3", protocolVersion: 1 });
        expect(scratch.methods()).toEqual(["initialize"]);
        expect(scratch.violations()).toEqual([]);
        // The probe ran in the scratch folder, with no folder asked for.
        expect(plans[plans.length - 1]?.folder).toBeNull();
        expect(manager.list()).toEqual([]);
    });

    it.each([
        ["2", "too new"],
        ["0", "too old"],
    ])("refuses an agent on protocol version %s (%s) and opens no session", async (version, words) => {
        const target = make({ FAKE_AGENT_VERSION: version });

        await expect(target.probe("fake")).rejects.toThrow(words);
        await expect(start(target)).rejects.toThrow(words);
        expect(scratch.methods().filter((method) => method === "session/new")).toEqual([]);
        expect(target.list().map((session) => session.status)).toEqual(["ended"]);
        target.killAll();
    });

    it("tells the user to sign in with the agent's own tool when the agent asks for a login", async () => {
        const target = make({ FAKE_AGENT_AUTH: "1" });

        await expect(start(target)).rejects.toThrow("sign in");
        target.killAll();
    });
});

describe("quitting", () => {
    it("kills the agent and everything it started", async () => {
        const id = await start();

        manager.send(id, "child");
        await expect.poll(() => snapshot(id).turns[0]?.text, { timeout: 8000 }).toMatch(PID_PREFIX);

        const grandchild = Number(PID.exec(snapshot(id).turns[0].text)?.[1]);

        expect(alive(grandchild)).toBe(true);
        manager.killAll();
        await expectGone(grandchild);
        await expect.poll(() => snapshot(id).status, { timeout: 8000 }).toBe("ended");
    });
});

describe("an agent that crashes", () => {
    it("takes nothing with it that it started: its tools are killed too, and so at quit", async () => {
        const id = await start();

        manager.send(id, "child");
        await expect.poll(() => snapshot(id).turns[0]?.text, { timeout: 8000 }).toMatch(PID_PREFIX);

        const [, grandchild, agentPid] = PID_AND_AGENT.exec(snapshot(id).turns[0].text) ?? [];

        expect(alive(Number(grandchild))).toBe(true);
        process.kill(Number(agentPid), "SIGKILL");
        await expectGone(Number(grandchild));
        await expect.poll(() => snapshot(id).status, { timeout: 8000 }).toBe("ended");
        // Quit after the crash has nothing left to kill, and does not fail.
        manager.killAll();
    });
});

describe("the environment", () => {
    it("is exactly the plan's: nothing is inherited from the app", async () => {
        vi.stubEnv("NEORE_LEAK", "from-the-app");
        vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");

        const target = make({ ONLY_FOR_THIS_AGENT: "yes" });
        const id = await start(target);

        target.send(id, "env");
        await idle(id, target);

        // macOS adds this one to every process it starts; it is not the app's.
        const names = Object.keys(JSON.parse(snapshot(id, target).turns[0].text) as Record<string, string>)
            .filter((name) => name !== "__CF_USER_TEXT_ENCODING")
            ;

        expect(new Set(names)).toEqual(new Set(["FAKE_AGENT_LOG", "ONLY_FOR_THIS_AGENT", "PATH"]));
        vi.unstubAllEnvs();
        target.killAll();
    });
});

describe("secrets in variables", () => {
    it("never reach a console line, an error or the window's snapshot", async () => {
        const consoles = (["debug", "error", "info", "log", "warn"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
        const stdout = vi.spyOn(process.stdout, "write");
        const stderr = vi.spyOn(process.stderr, "write");
        const target = make({ API_KEY: SENTINEL });
        const failures: string[] = [];

        // A start that fails while the agent echoes its environment to stderr.
        const crashing = make({ API_KEY: SENTINEL, FAKE_AGENT_FAIL_INIT: "1" });

        failures.push(await messageOf(crashing.startSession("fake", "Fake", scratch.work)), await messageOf(crashing.probe("fake")));

        // A crash in the middle of a turn, then a normal exit.
        const id = await start(target);

        target.send(id, "die");
        await expect.poll(() => snapshot(id, target).status, { timeout: 8000 }).toBe("ended");

        const normal = await start(target);

        target.send(normal, "hello");
        await idle(normal, target);
        await target.close(normal);

        const everything = JSON.stringify([failures, target.list(), consoles.flatMap((spy) => spy.mock.calls), stdout.mock.calls, stderr.mock.calls]);

        expect(failures.every((message) => message !== "")).toBe(true);
        expect(everything).not.toContain(SENTINEL);
        // The scrubbed text is still informative.
        expect(target.list().find((session) => session.id === id)?.endReason).toContain("dying, env=");
        expect(target.list().find((session) => session.id === id)?.endReason).toContain("***");
        target.killAll();
        crashing.killAll();
    });
});

describe("an agent that quotes its environment in an error", () => {
    it("is scrubbed in the thrown message, the cause and the window's snapshot", async () => {
        const target = make({ API_KEY: SENTINEL, FAKE_AGENT_SESSION_ERROR: "1" });
        let caught: Error | undefined;

        try {
            await start(target);
        } catch (error) {
            caught = error as Error;
        }

        expect(caught?.message).toBeTruthy();
        expect(caught?.message).not.toContain(SENTINEL);
        expect(caught?.cause).toBeUndefined();
        expect(JSON.stringify(target.list())).not.toContain(SENTINEL);
        expect(JSON.stringify(target.list())).toContain("***");
        target.killAll();
    });
});

describe("unsupported platforms and missing commands", () => {
    it("explains a command that does not exist", async () => {
        const target = make(
            {},
            {
                plan: () => {
                    return { args: [], command: "neore-no-such-agent", cwd: scratch.dir, env: { PATH: "/nonexistent" } };
                },
            },
        );

        await expect(target.probe("missing")).rejects.toThrow(MISSING_COMMAND);
    });
});
