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
        groups: {
            identity: { models: [], reasoningEffort: { reason: "not_offered", supported: false } },
            sessions: { listNative: { reason: "not_offered", supported: false }, load: { reason: "not_offered", supported: false } },
        },
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
    fixture = "handshake-and-prompt",
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
    const steps = readTranscript(fixture);

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
    it("is told what the agent reports about its usage, and only that", async () => {
        const { observer } = recorder();
        const reported: unknown[] = [];
        const watched: SessionObserver = {
            ...observer,
            sessionState: (_id, patch) => {
                reported.push(patch);
            },
        };
        const { player, session, steps } = await start(refuse, watched, undefined, undefined, "usage-and-prompt");

        session.send("say hi");
        await player.play(steps.slice(4));
        await expect.poll(() => session.snapshot().status).toBe("idle");

        expect(reported).toEqual([{ usage: { cost: { amount: 0.42, currency: "USD" }, size: 200_000, used: 12_345 } }]);
    });

    it("is told the tail of what a command tool printed, masked, and keeps it when a later update carries no content", async () => {
        const { calls, observer } = recorder();
        const secret = { scrub: (text: string) => text.replaceAll("TOKEN-123", "***"), secretLength: 9 };
        const { player, session, steps } = await start(refuse, observer, secret, undefined, "tool-output-and-prompt");

        session.send("say hi");
        await player.play(steps.slice(4));
        await expect.poll(() => session.snapshot().status).toBe("idle");

        expect(calls.filter(([name]) => name === "tool").map((call) => call[2])).toEqual([
            { id: "call_1", kind: "execute", status: "in_progress", title: "Run tests" },
            { id: "call_1", kind: "execute", output: "3 passed ***", status: "in_progress", title: "Run tests" },
            { id: "call_1", kind: "execute", output: "3 passed ***", status: "completed", title: "Run tests" },
        ]);
        // The window's transcript never carries what the call printed.
        expect(JSON.stringify(session.snapshot())).not.toContain("passed");
    });

    it("is told each plan the agent sends for the turn, whole", async () => {
        const { observer } = recorder();
        const plans: unknown[] = [];
        const watched: SessionObserver = {
            ...observer,
            plan: (_id, turnId, entries) => {
                plans.push([turnId, entries]);
            },
        };
        const { player, session, steps } = await start(refuse, watched, undefined, undefined, "plan-and-prompt");

        session.send("say hi");
        await player.play(steps.slice(4));
        await expect.poll(() => session.snapshot().status).toBe("idle");

        const [turn] = session.snapshot().turns;

        expect(plans).toEqual([
            [
                turn?.id,
                [
                    { content: "Read the code", priority: "high", status: "in_progress" },
                    { content: "Write the fix", priority: "medium", status: "pending" },
                ],
            ],
            [
                turn?.id,
                [
                    { content: "Read the code", priority: "high", status: "completed" },
                    { content: "Write the fix", priority: "medium", status: "in_progress" },
                ],
            ],
        ]);
    });

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

describe("a usage report the agent sends before its session answers", () => {
    it("reaches the meter once the session has opened, rather than being dropped", async () => {
        const reported: { usage?: unknown }[] = [];
        const agent = memoryAgent();
        const session = new AgentSession({
            agentKey: "example",
            agentLabel: "Example",
            appVersion: "9.9.9",
            folder: "/work",
            gate: refuse,
            hostInfo: HOST_INFO,
            observer: {
                ...recorder().observer,
                sessionState: (_id, patch) => {
                    reported.push(patch);
                },
            },
            onChange: () => {},
            process: agent.process,
        });
        const started = session.start();

        await expect.poll(() => agent.written.some((frame) => frame.method === "initialize")).toBe(true);
        const initialize = agent.written.find((frame) => frame.method === "initialize");

        agent.say({ id: initialize?.id, result: { agentCapabilities: {}, protocolVersion: 1 } });
        await expect.poll(() => agent.written.some((frame) => frame.method === "session/new")).toBe(true);

        agent.say({ method: "session/update", params: { sessionId: "sess_1", update: { sessionUpdate: "usage_update", size: 200_000, used: 12_345 } } });

        const opened = agent.written.find((frame) => frame.method === "session/new");

        agent.say({ id: opened?.id, result: { sessionId: "sess_1" } });
        await started;

        expect(reported).toContainEqual({ usage: expect.objectContaining({ used: 12_345 }) });
    });

    it("keeps the valid report when a malformed one follows it before the answer", async () => {
        const reported: { usage?: unknown }[] = [];
        const agent = memoryAgent();
        const session = new AgentSession({
            agentKey: "example",
            agentLabel: "Example",
            appVersion: "9.9.9",
            folder: "/work",
            gate: refuse,
            hostInfo: HOST_INFO,
            observer: {
                ...recorder().observer,
                sessionState: (_id, patch) => {
                    reported.push(patch);
                },
            },
            onChange: () => {},
            process: agent.process,
        });
        const started = session.start();

        await expect.poll(() => agent.written.some((frame) => frame.method === "initialize")).toBe(true);
        agent.say({ id: agent.written.find((frame) => frame.method === "initialize")?.id, result: { agentCapabilities: {}, protocolVersion: 1 } });
        await expect.poll(() => agent.written.some((frame) => frame.method === "session/new")).toBe(true);

        agent.say({ method: "session/update", params: { sessionId: "sess_1", update: { sessionUpdate: "usage_update", size: 200_000, used: 12_345 } } });
        agent.say({ method: "session/update", params: { sessionId: "sess_1", update: { sessionUpdate: "usage_update", size: 200_000, used: "lots" } } });

        agent.say({ id: agent.written.find((frame) => frame.method === "session/new")?.id, result: { sessionId: "sess_1" } });
        await started;

        expect(reported).toEqual([{ usage: { size: 200_000, used: 12_345 } }]);
    });

    it("does not give a fresh session the options an update for another session carries", async () => {
        const reported: { configOptions?: unknown }[] = [];
        const agent = memoryAgent();
        const session = new AgentSession({
            agentKey: "example",
            agentLabel: "Example",
            appVersion: "9.9.9",
            folder: "/work",
            gate: refuse,
            hostInfo: HOST_INFO,
            observer: {
                ...recorder().observer,
                sessionState: (_id, patch) => {
                    reported.push(patch);
                },
            },
            onChange: () => {},
            process: agent.process,
        });
        const started = session.start();

        await expect.poll(() => agent.written.some((frame) => frame.method === "initialize")).toBe(true);
        agent.say({ id: agent.written.find((frame) => frame.method === "initialize")?.id, result: { agentCapabilities: {}, protocolVersion: 1 } });
        await expect.poll(() => agent.written.some((frame) => frame.method === "session/new")).toBe(true);

        // The session's id is not known until session/new answers: an update naming another session is not this one's options.
        agent.say({
            method: "session/update",
            params: {
                sessionId: "sess_other",
                update: {
                    configOptions: [{ category: "model", currentValue: "deep", id: "model", name: "Model", options: [{ name: "Deep", value: "deep" }], type: "select" }],
                    sessionUpdate: "config_option_update",
                },
            },
        });

        agent.say({ id: agent.written.find((frame) => frame.method === "session/new")?.id, result: { sessionId: "sess_1" } });
        await started;

        expect(reported.filter((patch) => patch.configOptions !== undefined)).toEqual([]);
    });

    it("bounds what a chatty agent makes a fresh session keep before its answer, and still applies the latest option and usage", async () => {
        const reported: { configOptions?: unknown; usage?: unknown }[] = [];
        const agent = memoryAgent();
        const session = new AgentSession({
            agentKey: "example",
            agentLabel: "Example",
            appVersion: "9.9.9",
            folder: "/work",
            gate: refuse,
            hostInfo: HOST_INFO,
            observer: {
                ...recorder().observer,
                sessionState: (_id, patch) => {
                    reported.push(patch);
                },
            },
            onChange: () => {},
            process: agent.process,
        });
        const started = session.start();

        await expect.poll(() => agent.written.some((frame) => frame.method === "initialize")).toBe(true);
        agent.say({ id: agent.written.find((frame) => frame.method === "initialize")?.id, result: { agentCapabilities: {}, protocolVersion: 1 } });
        await expect.poll(() => agent.written.some((frame) => frame.method === "session/new")).toBe(true);

        const option = (value: number) => {
            return {
                category: "model",
                currentValue: `v${String(value)}`,
                id: "model",
                name: "Model",
                options: [{ name: "V", value: `v${String(value)}` }],
                type: "select",
            };
        };
        const update = (sessionId: string, fields: Record<string, unknown>) => {
            return { method: "session/update", params: { sessionId, update: fields } };
        };
        const COUNT = 1000;

        for (let index = 0; index < COUNT; index += 1) {
            // Other sessions' options and chatter that startup has no use for arrive between the answering session's reports.
            agent.say(update(`other-${String(index % 500)}`, { configOptions: [option(index)], sessionUpdate: "config_option_update" }));
            agent.say(update("sess_1", { content: { text: "hi", type: "text" }, sessionUpdate: "agent_message_chunk" }));
            agent.say(update("sess_1", { sessionUpdate: "usage_update", size: 200_000, used: index }));
            agent.say(update("sess_1", { configOptions: [option(index)], sessionUpdate: "config_option_update" }));
        }

        // Only the latest option list and the latest usage report of the answering session are kept, and few sessions in all.
        const retained = (session as unknown as { startupReads: Map<string, unknown[]> }).startupReads;

        await expect.poll(() => retained.get("sess_1")?.length).toBe(2);
        expect(retained.size).toBeLessThanOrEqual(4);
        let entries = 0;

        for (const reads of retained.values()) {
            entries += reads.length;
        }

        expect(entries).toBeLessThanOrEqual(4 * 3);

        agent.say({ id: agent.written.find((frame) => frame.method === "session/new")?.id, result: { sessionId: "sess_1" } });
        await started;

        expect(reported.find((patch) => patch.configOptions !== undefined)?.configOptions).toEqual([expect.objectContaining({ currentValue: `v${String(COUNT - 1)}` })]);
        let usage: unknown;

        for (const patch of reported) {
            if (patch.usage !== undefined) {
                usage = patch.usage;
            }
        }

        expect(usage).toEqual({ size: 200_000, used: COUNT - 1 });
    });

    it("keeps nothing of the updates a session sent before its answer when the session fails to open", async () => {
        const agent = memoryAgent();
        const session = new AgentSession({
            agentKey: "example",
            agentLabel: "Example",
            appVersion: "9.9.9",
            folder: "/work",
            gate: refuse,
            hostInfo: HOST_INFO,
            observer: recorder().observer,
            onChange: () => {},
            process: agent.process,
        });
        const started = session.start();

        await expect.poll(() => agent.written.some((frame) => frame.method === "initialize")).toBe(true);
        agent.say({ id: agent.written.find((frame) => frame.method === "initialize")?.id, result: { agentCapabilities: {}, protocolVersion: 1 } });
        await expect.poll(() => agent.written.some((frame) => frame.method === "session/new")).toBe(true);

        agent.say({
            method: "session/update",
            params: { sessionId: "sess_1", update: { configOptions: [{ category: "model", currentValue: "a", id: "model", name: "Model", options: [{ name: "A", value: "a" }], type: "select" }], sessionUpdate: "config_option_update" } },
        });
        await expect.poll(() => (session as unknown as { startupReads: Map<string, unknown[]> }).startupReads.size).toBe(1);

        agent.say({ error: { code: -32_000, message: "no session" }, id: agent.written.find((frame) => frame.method === "session/new")?.id });
        await expect(started).rejects.toThrow();

        expect((session as unknown as { startupReads: Map<string, unknown[]> }).startupReads.size).toBe(0);
    });
});

describe("a change asked for from the web or the phone", () => {
    it("refuses a mode, whichever way it is named, and never sends it to the agent", async () => {
        const agent = memoryAgent();
        const session = new AgentSession({
            agentKey: "example",
            agentLabel: "Example",
            appVersion: "9.9.9",
            folder: "/work",
            gate: refuse,
            hostInfo: HOST_INFO,
            observer: recorder().observer,
            onChange: () => {},
            process: agent.process,
        });

        // The legacy mode state (no option id) is a mode, refused before the session's own checks.
        await expect(session.setRemoteOption(undefined, "code")).rejects.toThrow("a mode is changed on the computer");
        expect(agent.written).toEqual([]);
    });
});
