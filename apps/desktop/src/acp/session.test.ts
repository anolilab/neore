/**
 * The protocol client against recorded transcripts (hand-written from the ACP v1 spec, validated against the
 * SDK's schema), with an in-memory agent so every frame the host writes can be compared exactly.
 */
import { PROTOCOL_VERSION as SDK_PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import type { PermissionGate } from "./permission";
import { declineGate } from "./permission";
import { PROTOCOL_VERSION } from "./protocol";
import { AgentSession } from "./session";
import { acpSchema, memoryAgent, readTranscript, transcriptPlayer } from "./testing/harness";

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

const refuseAll: PermissionGate = {
    ask: async () => {
        return { outcome: "cancelled" };
    },
    cancelSession: () => {},
};

const setup = async (gate: PermissionGate = refuseAll) => {
    const agent = memoryAgent();
    const session = new AgentSession({
        agentKey: "example",
        agentLabel: "Example",
        appVersion: "9.9.9",
        folder: "/work",
        gate,
        onChange: () => {},
        process: agent.process,
    });
    const player = transcriptPlayer(agent);
    const steps = readTranscript("handshake-and-prompt");

    // initialize, then session/new
    await Promise.all([session.start(), player.play(steps.slice(0, 4))]);

    return { agent, player, session, steps };
};

describe("protocol version", () => {
    it("is the SDK's stable line", () => {
        expect(PROTOCOL_VERSION).toBe(SDK_PROTOCOL_VERSION);
        expect(PROTOCOL_VERSION).toBe(1);
    });
});

describe("a recorded session", () => {
    it("handshakes, prompts and reads the reply; every frame the host wrote passes the schema", async () => {
        const { agent, player, session, steps } = await setup();

        expect(session.snapshot().status).toBe("idle");
        expect(session.handshake).toMatchObject({ agentName: "example-agent", agentVersion: "0.4.1", protocolVersion: 1 });

        const sent = session.send("say hi");

        expect(sent).toEqual({ status: "started" });
        await player.play(steps.slice(4));
        await expect.poll(() => session.snapshot().status).toBe("idle");

        const [turn] = session.snapshot().turns;

        expect(turn).toMatchObject({ stopReason: "end_turn", text: "Hi there", thought: "thinking", user: "say hi" });

        const byMethod: Record<string, string> = { initialize: "InitializeRequest", "session/new": "NewSessionRequest", "session/prompt": "PromptRequest" };

        for (const frame of agent.written) {
            const definition = byMethod[frame.method as string];

            expect(definition, `unexpected ${String(frame.method)}`).toBeDefined();
            expect(acpSchema(definition).safeParse(frame.params).success).toBe(true);
        }
    });

    it("answers file system and terminal requests with 'method not found', since it offers neither", async () => {
        const { agent, player } = await setup();

        await player.play(readTranscript("unsupported-requests"));
        expect(agent.written.map((frame) => frame.error)).toEqual([undefined, undefined, { code: -32_601, message: "method not found" }, { code: -32_601, message: "method not found" }]);
    });

    it("sends session/cancel and answers a waiting permission request 'cancelled'", async () => {
        let release: (() => void) | undefined;
        const held: PermissionGate = {
            ask: () =>
                new Promise((resolve) => {
                    release = () => resolve({ outcome: "cancelled" });
                }),
            cancelSession: () => release?.(),
        };
        const { player, session } = await setup(held);

        session.send("run it");

        const steps = readTranscript("cancel-with-permission");

        // Up to and including the permission request; then the user stops the turn.
        const reached = player.play(steps.slice(0, 3));

        await reached;
        await expect.poll(() => release !== undefined).toBe(true);
        session.cancel();
        await player.play(steps.slice(3));
        await expect.poll(() => session.snapshot().status).toBe("idle");

        const snapshot = session.snapshot();

        expect(snapshot.turns[0].stopReason).toBe("cancelled");
        expect(snapshot.turns[0].tools).toEqual([{ id: "call_1", kind: "execute", status: "cancelled", title: "Run tests" }]);
    });
});

describe("the end of a turn", () => {
    const update = (sessionUpdate: string, rest: Record<string, unknown>) => {
        return { method: "session/update", params: { sessionId: "sess_1", update: { sessionUpdate, ...rest } } };
    };

    it("is the prompt response alone: a final-looking update does not release a queued prompt", async () => {
        const { agent, session } = await setup();

        session.send("first");
        await expect.poll(() => agent.written.length).toBe(3);

        expect(session.send("second")).toEqual({ position: 1, status: "queued" });

        // Everything is finished as far as the updates say…
        agent.say(update("tool_call", { kind: "other", status: "completed", title: "Quick job", toolCallId: "e1" }));
        agent.say(update("agent_message_chunk", { content: { text: "all done", type: "text" } }));
        await expect.poll(() => session.snapshot().turns[0].text).toBe("all done");
        await sleep(60);

        // …and still only one prompt went out, and the session is busy.
        expect(agent.written).toHaveLength(3);
        expect(session.snapshot().status).toBe("busy");
        expect(session.snapshot().queued).toEqual(["second"]);

        // The response arrives; only now does the queued prompt follow.
        agent.say({ id: agent.written[2].id as number, result: { stopReason: "end_turn" } });
        await expect.poll(() => agent.written.length).toBe(4);
        expect(agent.written[3]).toMatchObject({ method: "session/prompt", params: { prompt: [{ text: "second", type: "text" }] } });
    });

    it("is not undone by an update that arrives after the response", async () => {
        const { agent, session } = await setup();

        session.send("first");
        await expect.poll(() => agent.written.length).toBe(3);
        agent.say(update("tool_call", { kind: "other", status: "in_progress", title: "Slow job", toolCallId: "l1" }));
        agent.say({ id: agent.written[2].id as number, result: { stopReason: "end_turn" } });
        await expect.poll(() => session.snapshot().status).toBe("idle");

        agent.say(update("tool_call_update", { status: "completed", toolCallId: "l1" }));
        agent.say(update("agent_message_chunk", { content: { text: " (late)", type: "text" } }));
        await expect.poll(() => session.snapshot().turns[0].text).toBe(" (late)");

        const snapshot = session.snapshot();

        expect(snapshot.status).toBe("idle");
        expect(snapshot.turns[0].tools[0].status).toBe("completed");
        expect(agent.written).toHaveLength(3);
    });

    it("ends the session, not just the turn, when the agent's output closes mid-turn", async () => {
        const { agent, session } = await setup();

        session.send("first");
        await expect.poll(() => agent.written.length).toBe(3);
        agent.end();
        await expect.poll(() => session.snapshot().status).toBe("ended");
        expect(session.snapshot().turns[0].stopReason).toBe("failed");
        expect(() => session.send("again")).toThrow("ended");
    });
});

describe("a request the user declined", () => {
    const ask = (id: number, toolCallId: string) => {
        return {
            id,
            method: "session/request_permission",
            params: {
                options: [
                    { kind: "allow_once", name: "Allow", optionId: "allow" },
                    { kind: "reject_once", name: "Reject", optionId: "reject" },
                ],
                sessionId: "sess_1",
                toolCall: { title: "Run it", toolCallId },
            },
        };
    };

    it("ends the call as declined on this side, even when the agent says nothing more, and sends the agent its reject option", async () => {
        const { agent, session } = await setup(declineGate);

        session.send("go");
        await expect.poll(() => agent.written.length).toBe(3);
        agent.say({ method: "session/update", params: { sessionId: "sess_1", update: { kind: "execute", sessionUpdate: "tool_call", status: "pending", title: "Run it", toolCallId: "c1" } } });
        agent.say(ask(9, "c1"));
        await expect.poll(() => agent.written.length).toBe(4);

        expect(agent.written[3]).toMatchObject({ id: 9, result: { outcome: { optionId: "reject", outcome: "selected" } } });
        expect(session.snapshot().turns[0].tools[0].status).toBe("declined");

        // The agent reports the call in progress anyway: it stays declined.
        agent.say({ method: "session/update", params: { sessionId: "sess_1", update: { sessionUpdate: "tool_call_update", status: "in_progress", toolCallId: "c1" } } });
        await expect.poll(() => session.snapshot().turns[0].tools[0].status).toBe("declined");
    });

    it("leaves a call the user allowed to the agent's own reports", async () => {
        const allow: PermissionGate = {
            ask: async () => { return { optionId: "allow", outcome: "selected" }; },
            cancelSession: () => {},
        };
        const { agent, session } = await setup(allow);

        session.send("go");
        await expect.poll(() => agent.written.length).toBe(3);
        agent.say({ method: "session/update", params: { sessionId: "sess_1", update: { sessionUpdate: "tool_call", status: "pending", title: "Run it", toolCallId: "c1" } } });
        agent.say(ask(9, "c1"));
        await expect.poll(() => agent.written.length).toBe(4);

        expect(agent.written[3]).toMatchObject({ result: { outcome: { optionId: "allow" } } });
        expect(session.snapshot().turns[0].tools[0].status).toBe("pending");
    });
});
