/**
 * An agent's own children through a session (plans/acp-agent-host.md §4.7): what an agent that stamps its children's
 * updates with their parent call (`_meta.claudeCode.parentToolUseId`) sends is kept out of the reply, shown after its
 * spawn call appears when the agent reports children, and shown nowhere when it does not.
 */
import type { CapabilityReport } from "@neore/ai/capabilities";
import { describe, expect, it } from "vitest";

import type { ChildEvent } from "./children";
import type { SessionObserver } from "./ingest";
import type { PermissionGate } from "./permission";
import { AgentSession } from "./session";
import { memoryAgent, readTranscript, transcriptPlayer } from "./testing/harness";

const REPORTS_CHILDREN: CapabilityReport = {
    groups: { subagents: { ownChildren: { degradation: "none", supported: true } } },
    reportedAt: 1,
    version: 1,
};

const ask: PermissionGate = {
    ask: async () => {
        return { outcome: "cancelled" };
    },
    cancelSession: () => {},
};

const begin = async (options: { report?: CapabilityReport } = {}) => {
    const calls: string[] = [];
    const children: { event: ChildEvent; spawnId: string }[] = [];
    const logs: string[] = [];
    const observer: SessionObserver = {
        child: (_sessionId, _turnId, spawnId, event) => {
            calls.push(`child:${event.kind}`);
            children.push({ event, spawnId });
        },
        permissionRequested: () => {},
        permissionResolved: () => {},
        sessionEnded: () => {},
        sessionOpened: () => {},
        text: () => {},
        thought: () => {},
        tool: (_sessionId, _turnId, tool) => {
            calls.push(`tool:${tool.id}:${tool.status}`);
        },
        turnEnded: () => {},
        turnStarted: () => {},
    };
    const agent = memoryAgent();
    const session = new AgentSession({
        agentKey: "example",
        agentLabel: "Example",
        appVersion: "9.9.9",
        folder: "/work",
        gate: ask,
        hostInfo: { agentKey: "example", agentLabel: "Example", folderId: "f1", folderLabel: "neore" },
        log: (message) => {
            logs.push(message);
        },
        observer,
        onChange: () => {},
        process: agent.process,
        ...options.report !== undefined && { capabilityReport: () => options.report as CapabilityReport },
    });
    const player = transcriptPlayer(agent);
    const steps = readTranscript("handshake-and-prompt");

    await Promise.all([session.start(), player.play(steps.slice(0, 4))]);
    session.send("say hi");
    await player.play(steps.slice(4, 5));

    const update = (body: Record<string, unknown>, parent?: string): void =>
        agent.say({
            method: "session/update",
            params: { sessionId: "sess_1", update: { ...body, ...parent !== undefined && { _meta: { claudeCode: { parentToolUseId: parent } } } } },
        });
    const finish = async (): Promise<void> => {
        agent.say({ id: agent.written.at(-1)?.id, result: { stopReason: "end_turn" } });
        await expect.poll(() => session.snapshot().status).toBe("idle");
    };

    return { agent, calls, children, finish, logs, session, update };
};

const message = (value: string) => {
    return { content: { text: value, type: "text" }, sessionUpdate: "agent_message_chunk" };
};

const spawn = { kind: "think", sessionUpdate: "tool_call", status: "in_progress", title: "Task", toolCallId: "task1" };

describe("an agent that reports its children", () => {
    it("shows a child's events under the call that spawned it, and out of the agent's own reply", async () => {
        const { calls, children, finish, session, update } = await begin({ report: REPORTS_CHILDREN });

        update(message("I will delegate."));
        update(spawn);
        update(message("child here"), "task1");
        update({ kind: "read", sessionUpdate: "tool_call", status: "pending", title: "Read a.ts", toolCallId: "inner1" }, "task1");
        update({ content: [{ content: { text: "child here", type: "text" }, type: "content" }], sessionUpdate: "tool_call_update", status: "completed", toolCallId: "task1" });
        await finish();

        const [turn] = session.snapshot().turns;

        expect(turn?.text).toBe("I will delegate.");
        // The child's own tool call is the child's, not one of the agent's.
        expect(turn?.tools.map((tool) => tool.id)).toEqual(["task1"]);
        expect(calls).toEqual(["tool:task1:in_progress", "child:text", "child:tool", "tool:task1:completed", "child:end"]);
        expect(children.map(({ spawnId }) => spawnId)).toEqual(["task1", "task1", "task1"]);
        // It streamed its text, so the completion does not repeat it.
        expect(children.at(-1)?.event).toEqual({ kind: "end", status: "completed" });
    });

    it("holds an event that comes before its parent call, and shows it after the call, once", async () => {
        const { calls, children, finish, update } = await begin({ report: REPORTS_CHILDREN });

        update(message("early"), "task1");
        expect(children).toEqual([]);

        update(spawn);
        update({ ...spawn, sessionUpdate: "tool_call_update", status: "in_progress" });
        await finish();

        expect(calls.slice(0, 2)).toEqual(["tool:task1:in_progress", "child:text"]);
        expect(children.filter(({ event }) => event.kind === "text")).toHaveLength(1);
    });

    it("never makes a card from an event that names a call that does not appear", async () => {
        const { children, finish, logs, update } = await begin({ report: REPORTS_CHILDREN });

        update(message("who am I"), "unknown-call");
        await finish();

        expect(children).toEqual([]);
        expect(logs.join("\n")).toContain("never met their parent");
    });

    it("keeps the completion's full text for a child that streamed none, and ignores a repeated end", async () => {
        const { children, finish, update } = await begin({ report: REPORTS_CHILDREN });

        update(spawn);
        update({ kind: "read", sessionUpdate: "tool_call", status: "completed", title: "Read", toolCallId: "inner1" }, "task1");

        const done = { content: [{ content: { text: "Two files changed.", type: "text" }, type: "content" }], sessionUpdate: "tool_call_update", status: "completed", toolCallId: "task1" };

        update(done);
        update(done);
        await finish();

        expect(children.filter(({ event }) => event.kind === "end").map(({ event }) => event)).toEqual([{ kind: "end", status: "completed", text: "Two files changed." }]);
    });

    it("ends an open card as cancelled when the turn is cancelled", async () => {
        const { children, session, update } = await begin({ report: REPORTS_CHILDREN });

        update(spawn);
        update(message("working"), "task1");
        session.cancel();

        expect(children.at(-1)?.event).toEqual({ kind: "end", status: "cancelled" });
    });
});

describe("an agent that does not report its children", () => {
    it("keeps them inside the agent: nothing of theirs is shown or added to the reply", async () => {
        const { calls, children, finish, session, update } = await begin();

        update(message("I will delegate."));
        update(spawn);
        update(message("child here"), "task1");
        update({ kind: "read", sessionUpdate: "tool_call", status: "pending", title: "Read a.ts", toolCallId: "inner1" }, "task1");
        await finish();

        const [turn] = session.snapshot().turns;

        expect(children).toEqual([]);
        expect(turn?.text).toBe("I will delegate.");
        expect(turn?.tools.map((tool) => tool.id)).toEqual(["task1"]);
        expect(calls).toEqual(["tool:task1:in_progress"]);
    });
});
