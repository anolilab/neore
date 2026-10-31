/**
 * What a session tells its observer (the poster that saves turns on the backend): the session opening, each turn,
 * its text, tool calls and permission requests, and how it ended. The observer is told in the order things
 * happen, never an "always" option, never a folder path, and never a value the user asked to mask.
 */
import { describe, expect, it } from "vitest";

import type { HostSessionInfo, SessionObserver } from "./ingest";
import type { PermissionGate } from "./permission";
import { AgentSession } from "./session";
import { memoryAgent, readTranscript, transcriptPlayer } from "./testing/harness";

const HOST_INFO: HostSessionInfo = { agentKey: "example", agentLabel: "Example", folderId: "f1", folderLabel: "neore" };

/** What the backend is told when the session opens: the labels, the agent's own session id and what it advertised at the handshake. */
const OPENED = {
    ...HOST_INFO,
    capabilities: {
        groups: { sessions: { listNative: { reason: "not_offered", supported: false }, load: { reason: "not_offered", supported: false } } },
        reportedAt: expect.any(Number),
        version: 1,
    },
    nativeSessionId: "sess_1",
};

const recorder = () => {
    const calls: unknown[][] = [];
    const record
        = (name: string) =>
            (...args: unknown[]): void => {
                calls.push([name, ...args.slice(1)]);
            };
    const observer: SessionObserver = {
        permissionRequested: record("permissionRequested"),
        permissionResolved: record("permissionResolved"),
        sessionEnded: () => {},
        sessionOpened: (_sessionId, info, threadId) => {
            calls.push(threadId === undefined ? ["sessionOpened", info] : ["sessionOpened", info, threadId]);
        },
        text: record("text"),
        thought: record("thought"),
        tool: record("tool"),
        turnEnded: record("turnEnded"),
        turnReceived: record("turnReceived"),
        turnStarted: record("turnStarted"),
    };

    return { calls, observer };
};

const start = async (
    gate: PermissionGate,
    observer: SessionObserver,
    secret?: { scrub: (text: string) => string; secretLength: number },
    remote?: { sessionId: string; threadId: string },
) => {
    const agent = memoryAgent();
    const session = new AgentSession({
        ...remote,
        agentKey: "example",
        agentLabel: "Example",
        appVersion: "9.9.9",
        folder: "/work",
        gate,
        hostInfo: HOST_INFO,
        observer,
        onChange: () => {},
        process: { ...agent.process, ...secret },
    });
    const player = transcriptPlayer(agent);
    const steps = readTranscript("handshake-and-prompt");

    await Promise.all([session.start(), player.play(steps.slice(0, 4))]);

    return { agent, player, session, steps };
};

const refuse: PermissionGate = {
    ask: async () => {
        return { outcome: "cancelled" };
    },
    cancelSession: () => {},
};

describe("a session's observer", () => {
    it("is told the session opened, the turn, its text and its end, in order", async () => {
        const { calls, observer } = recorder();
        const { player, session, steps } = await start(refuse, observer);

        session.send("say hi");
        await player.play(steps.slice(4));
        await expect.poll(() => session.snapshot().status).toBe("idle");

        expect(calls).toEqual([
            ["sessionOpened", OPENED],
            ["turnStarted", expect.any(String), "say hi"],
            ["thought", expect.any(String), "thinking"],
            ["text", expect.any(String), "Hi"],
            ["text", expect.any(String), " there"],
            ["turnEnded", expect.any(String), "end_turn", undefined],
        ]);
    });

    it("sees a tool call, a permission request without a path or an always option, and the cancel", async () => {
        const { calls, observer } = recorder();
        let release: (() => void) | undefined;
        const held: PermissionGate = {
            ask: async () =>
                await new Promise((resolve) => {
                    release = () => resolve({ outcome: "cancelled" });
                }),
            cancelSession: () => release?.(),
        };
        const { player, session } = await start(held, observer);
        const steps = readTranscript("cancel-with-permission");

        session.send("run it");
        await player.play(steps.slice(0, 3));
        await expect.poll(() => release !== undefined).toBe(true);
        session.cancel();
        await player.play(steps.slice(3));
        await expect.poll(() => session.snapshot().status).toBe("idle");

        const names = calls.map(([name]) => name);

        expect(names).toEqual(["sessionOpened", "turnStarted", "tool", "permissionRequested", "tool", "permissionResolved", "turnEnded"]);

        const request = calls.find(([name]) => name === "permissionRequested")?.[2] as Record<string, unknown>;

        expect(request).toMatchObject({ folder: "neore", kind: "permission_request", tool: "Run tests" });
        expect(JSON.stringify(request)).not.toContain("/work");
        expect(calls.find(([name]) => name === "permissionResolved")?.slice(2)).toEqual([expect.any(String), "cancelled"]);
        expect(calls.filter(([name]) => name === "tool").map((call) => (call[2] as { status: string }).status)).toEqual(["pending", "cancelled"]);
        expect(calls.at(-1)).toEqual(["turnEnded", expect.any(String), "cancelled", undefined]);
    });

    it("closes a request still open when the agent ends the turn, before the turn's end", async () => {
        const { calls, observer } = recorder();
        let release: (() => void) | undefined;
        const held: PermissionGate = {
            ask: async () =>
                await new Promise((resolve) => {
                    release = () => resolve({ outcome: "cancelled" });
                }),
            cancelSession: () => release?.(),
        };
        const { agent, player, session } = await start(held, observer);
        const steps = readTranscript("cancel-with-permission");

        session.send("run it");
        await player.play(steps.slice(0, 3));
        await expect.poll(() => release !== undefined).toBe(true);
        // The agent finishes its prompt without the user ever answering.
        agent.say({ id: agent.written.find((frame) => frame.method === "session/prompt")?.id as number, result: { stopReason: "end_turn" } });
        await expect.poll(() => session.snapshot().status).toBe("idle");

        const names = calls.map(([name]) => name);

        expect(names.filter((name) => name === "permissionResolved")).toHaveLength(1);
        expect(names.indexOf("permissionResolved")).toBeLessThan(names.indexOf("turnEnded"));
    });

    it("holds back a value the user masked until it can be recognised, so it is never posted", async () => {
        const { calls, observer } = recorder();
        const secret = "hunter22";
        const { agent, player, session, steps } = await start(refuse, observer, {
            scrub: (text) => text.replaceAll(secret, "***"),
            secretLength: secret.length,
        });

        session.send("say hi");
        await player.play(steps.slice(4, 5));
        agent.say({ method: "session/update", params: { sessionId: "sess_1", update: { content: { text: "token hunt", type: "text" }, sessionUpdate: "agent_message_chunk" } } });
        await expect.poll(() => session.snapshot().turns[0]?.text).toBe("token hunt");
        agent.say({ method: "session/update", params: { sessionId: "sess_1", update: { content: { text: "er22 done", type: "text" }, sessionUpdate: "agent_message_chunk" } } });
        await expect.poll(() => session.snapshot().turns[0]?.text).toBe("token *** done");
        await player.play(steps.slice(-1));
        await expect.poll(() => session.snapshot().status).toBe("idle");

        const posted = calls.filter(([name]) => name === "text").map((call) => call[2] as string);

        expect(posted.join("")).toBe("token *** done");
        expect(posted.some((delta) => delta.includes("hunt"))).toBe(false);
    });

    it("ends the turn as failed, with why, when the agent goes away mid-turn", async () => {
        const { calls, observer } = recorder();
        const { agent, player, session, steps } = await start(refuse, observer);

        session.send("say hi");
        await player.play(steps.slice(4, 5));
        agent.end();
        await expect.poll(() => session.snapshot().status).toBe("ended");

        const ended = calls.find(([name]) => name === "turnEnded") ?? [];

        expect(ended[2]).toBe("failed");
        expect(typeof ended[3]).toBe("string");
    });
});

describe("a session and turns the backend sent", () => {
    it("goes by the id the backend made, and says which thread it is", async () => {
        const { calls, observer } = recorder();
        const { session } = await start(refuse, observer, undefined, { sessionId: "backend-session", threadId: "thread-1" });

        expect(session.id).toBe("backend-session");
        expect(calls).toEqual([["sessionOpened", OPENED, "thread-1"]]);
    });

    it("runs a prompt under the turn id it was sent with, received before it starts", async () => {
        const { calls, observer } = recorder();
        const { player, session, steps } = await start(refuse, observer);

        session.send("say hi", "turn-1");
        await player.play(steps.slice(4));
        await expect.poll(() => session.snapshot().status).toBe("idle");

        expect(calls.filter(([name]) => ["turnEnded", "turnReceived", "turnStarted"].includes(name as string))).toEqual([
            ["turnReceived", "turn-1", "say hi"],
            ["turnStarted", "turn-1", "say hi"],
            ["turnEnded", "turn-1", "end_turn", undefined],
        ]);
        expect(session.snapshot().turns[0]?.id).toBe("turn-1");
    });

    it("tells the backend a queued prompt was received at once, and ends it when it is withdrawn", async () => {
        const { calls, observer } = recorder();
        const { player, session, steps } = await start(refuse, observer);

        session.send("say hi");
        await player.play(steps.slice(4, 5));
        expect(session.send("second", "turn-2")).toEqual({ position: 1, status: "queued" });
        expect(calls.filter(([name]) => name === "turnReceived")).toEqual([["turnReceived", "turn-2", "second"]]);

        expect(session.cancelTurn("turn-2")).toBe(true);
        expect(session.summary().queued).toBe(0);
        expect(calls.at(-1)).toEqual(["turnEnded", "turn-2", "cancelled"]);
        // A turn that is not waiting and not running is not this session's to cancel.
        expect(session.cancelTurn("turn-2")).toBe(false);

        await player.play(steps.slice(5));
        await expect.poll(() => session.snapshot().status).toBe("idle");
    });

    it("ends every prompt the backend queued when the turn is stopped, so no stream waits on one", async () => {
        const { calls, observer } = recorder();
        const { player, session, steps } = await start(refuse, observer);

        session.send("say hi");
        await player.play(steps.slice(4, 5));
        session.send("second", "turn-2");
        session.send("third", "turn-3");
        session.cancel();

        const ended = calls.filter(([name]) => name === "turnEnded").map((call) => [call[1], call[2]]);

        expect(ended).toEqual([
            ["turn-2", "cancelled"],
            ["turn-3", "cancelled"],
        ]);
        expect(session.summary().queued).toBe(0);
    });

    it("ends them as failed, with why, when the agent goes away", async () => {
        const { calls, observer } = recorder();
        const { agent, player, session, steps } = await start(refuse, observer);

        session.send("say hi");
        await player.play(steps.slice(4, 5));
        session.send("second", "turn-2");
        agent.end();
        await expect.poll(() => session.snapshot().status).toBe("ended");

        const waiting = calls.find(([name, turnId]) => name === "turnEnded" && turnId === "turn-2") ?? [];

        expect(waiting[2]).toBe("failed");
        expect(typeof waiting[3]).toBe("string");
    });
});
