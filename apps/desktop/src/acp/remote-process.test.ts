/**
 * The adapter that makes an agent on a server look like a local process: bytes in both directions, the exit, and what a
 * stop does. The core is a stand-in that records what it was asked and delivers the events a real one would.
 */
import { describe, expect, it, vi } from "vitest";

import type { RemoteAgentCore, RemoteAgentEvent } from "./remote-process";
import { RemoteAgents } from "./remote-process";
import type { SpawnPlan } from "./types";

const plan = (overrides: Partial<SpawnPlan> = {}): SpawnPlan => {
    return { args: ["--acp"], command: "/opt/agent", cwd: "/srv/app", env: { TOKEN: "s3cret-value" }, scratch: false, secretNames: ["TOKEN"], ...overrides };
};

const b64 = (text: string): string => Buffer.from(text).toString("base64");

const setup = (start?: RemoteAgentCore["hostAgentStart"]) => {
    const calls: { start: unknown[][]; stop: number[]; write: { bytes: Buffer; handle: number }[] } = { start: [], stop: [], write: [] };
    const core: RemoteAgentCore = {
        hostAgentStart: (...args) => {
            calls.start.push(args);

            return start?.(...args) ?? "{}";
        },
        hostAgentStop: (handle) => {
            calls.stop.push(handle);
        },
        hostAgentWrite: (handle, bytes) => {
            calls.write.push({ bytes, handle });
        },
    };

    const agents = new RemoteAgents(core);

    return { agents, calls, event: (event: RemoteAgentEvent) => agents.dispatch(event) };
};

describe("an agent on a server as a process", () => {
    it("starts the named agent for the server's device in the planned folder", () => {
        const { agents, calls } = setup();

        agents.spawner("srv-1")(plan(), "claude");

        expect(calls.start).toEqual([["srv-1", 1, "claude", "/srv/app"]]);
    });

    it("gives its output in order, its stderr as a tail, and ends with the exit status", async () => {
        const { agents, event } = setup();
        const child = agents.spawner("srv-1")(plan(), "claude");
        const heard: string[] = [];

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            heard.push(chunk);
        });
        event({ data: b64("one\n"), handle: 1, stream: "stdout", type: "hostAgent" });
        event({ data: b64("bad: s3cret-value\n"), handle: 1, stream: "stderr", type: "hostAgent" });
        event({ data: b64("two\n"), handle: 1, stream: "stdout", type: "hostAgent" });
        event({ code: null, error: null, handle: 1, signal: 15, type: "hostAgentEnded" });

        expect(await child.exited).toEqual({ code: null, signal: "SIGTERM" });
        expect(heard.join("")).toBe("one\ntwo\n");
        // The value the person set never reaches an error message.
        expect(child.stderrTail()).toBe("bad: ***\n");
        expect(child.secretLength).toBe("s3cret-value".length);
    });

    it("takes output that arrives before the start returns", async () => {
        let delivered: ((event: RemoteAgentEvent) => boolean) | undefined;
        const { agents, event } = setup(() => {
            delivered?.({ data: b64("early\n"), handle: 1, stream: "stdout", type: "hostAgent" });

            return "{}";
        });

        delivered = event;

        const child = agents.spawner("srv-1")(plan(), "claude");

        child.stdout.setEncoding("utf8");

        const first = await new Promise((resolve) => {
            child.stdout.once("data", resolve);
        });

        expect(first).toBe("early\n");
    });

    it("sends its stdin to the core and closes it with an empty write", async () => {
        const { agents, calls } = setup();
        const child = agents.spawner("srv-1")(plan(), "claude");

        await new Promise<void>((resolve) => {
            child.stdin.write("hello\n", () => resolve());
        });
        await new Promise<void>((resolve) => {
            child.stdin.end(() => resolve());
        });

        expect(calls.write.map(({ bytes, handle }) => [handle, bytes.toString()])).toEqual([[1, "hello\n"], [1, ""]]);
    });

    it("fails a write to an agent that has ended, and reports a connection that failed instead of an exit", async () => {
        const { agents, event } = setup();
        const child = agents.spawner("srv-1")(plan(), "claude");

        event({ code: null, error: "the connection to the server was lost", handle: 1, signal: null, type: "hostAgentEnded" });

        expect(await child.exited).toEqual({ code: null, signal: null });
        expect(child.stderrTail()).toContain("the connection to the server was lost");
        const failure = await new Promise<Error | null | undefined>((resolve) => {
            child.stdin.write("x", resolve);
        });

        expect(failure?.message).toContain("EPIPE");
    });

    it("refuses with the core's reason, naming no value, and leaves nothing registered", () => {
        const { agents, event } = setup(() => {
            throw new Error("this computer is not connected to build-box (s3cret-value)");
        });

        expect(() => agents.spawner("srv-1")(plan(), "claude")).toThrow("could not start /opt/agent: this computer is not connected to build-box (***)");
        // An event for the handle that never started is dropped.
        expect(event({ data: b64("x"), handle: 1, stream: "stdout", type: "hostAgent" })).toBe(true);
    });

    it("asks the core to stop the group and waits for the server to report it", async () => {
        const { agents, calls, event } = setup();
        const child = agents.spawner("srv-1")(plan(), "claude");
        const stopped = child.stop();

        expect(calls.stop).toEqual([1]);
        event({ code: null, error: null, handle: 1, signal: 15, type: "hostAgentEnded" });
        await stopped;
        await child.stop();

        // Already gone: nothing more is asked.
        expect(calls.stop).toEqual([1]);
    });

    it("stops waiting for a server that does not report the end", async () => {
        vi.useFakeTimers();

        try {
            const { agents } = setup();
            const child = agents.spawner("srv-1")(plan(), "claude");
            const stopped = child.stop();

            await vi.advanceTimersByTimeAsync(10_001);
            await stopped;

            expect(await child.exited).toEqual({ code: null, signal: null });
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps each agent's output to itself and ignores events that are not its own", () => {
        const { agents, event } = setup();
        const first = agents.spawner("srv-1")(plan(), "a");
        const second = agents.spawner("srv-2")(plan(), "b");
        const heard: string[][] = [[], []];

        for (const [index, child] of [first, second].entries()) {
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => {
                heard[index]?.push(chunk);
            });
        }

        event({ data: b64("for-two"), handle: 2, stream: "stdout", type: "hostAgent" });

        expect(heard).toEqual([[], ["for-two"]]);
        expect(agents.dispatch({ type: "changed" })).toBe(false);
    });
});
