/**
 * The options an agent offers: read from what it sends when the session opens, followed through its own updates, reported to the
 * observer, and changed on the backend's behalf (`setOption`) with only a value the agent offered and a fixed reason when it refuses.
 */
import { capabilityOf, isAvailable } from "@neore/ai/capabilities";
import { describe, expect, it } from "vitest";

import type { SessionStatePatch } from "./host-events";
import type { HostSessionInfo, SessionObserver } from "./ingest";
import type { PermissionGate } from "./permission";
import { AgentSession } from "./session";
import { acpSchema, memoryAgent, readTranscript, transcriptPlayer } from "./testing/harness";

const HOST_INFO: HostSessionInfo = { agentKey: "example", agentLabel: "Example", folderId: "f1", folderLabel: "neore" };

const PRIVATE = /private/u;

const refuse: PermissionGate = {
    ask: async () => ({ optionId: "no", outcome: "selected" } as never),
    cancelSession: () => {},
} as never;

const start = async (fixture: string) => {
    const agent = memoryAgent();
    const opened: HostSessionInfo[] = [];
    const states: SessionStatePatch[] = [];
    const observer = {
        permissionRequested: () => {},
        permissionResolved: () => {},
        sessionEnded: () => {},
        sessionOpened: (_id: string, info: HostSessionInfo) => {
            opened.push(info);
        },
        sessionState: (_id: string, patch: SessionStatePatch) => {
            states.push(patch);
        },
        text: () => {},
        thought: () => {},
        tool: () => {},
        turnEnded: () => {},
        turnStarted: () => {},
    } as SessionObserver;
    const session = new AgentSession({
        agentKey: "example",
        agentLabel: "Example",
        appVersion: "9.9.9",
        folder: "/work",
        gate: refuse,
        hostInfo: HOST_INFO,
        observer,
        onChange: () => {},
        process: agent.process,
    });
    const player = transcriptPlayer(agent);
    const steps = readTranscript(fixture);
    const opening = steps.findIndex((step) => "in" in step && step.in.id === "$2") + 1;

    await Promise.all([session.start(), player.play(steps.slice(0, opening))]);

    return { agent, opened, player, session, states, steps: steps.slice(opening) };
};

describe("the options an agent offers when the session opens", () => {
    it("reports the options alone when the agent sends them beside the legacy states, and the capabilities say what it can do", async () => {
        const { opened, states } = await start("options-and-change");

        expect(states).toHaveLength(1);
        expect(Object.keys(states[0] ?? {})).toEqual(["configOptions"]);
        expect(states[0]?.configOptions?.map((option) => [option.id, option.category, option.currentValue])).toEqual([
            ["model", "model", "fast"],
            ["effort", "thought_level", "high"],
            ["mode", "mode", "ask"],
        ]);
        // A grouped option is one flat list of choices.
        expect(states[0]?.configOptions?.[2]?.choices).toEqual([
            { name: "Ask", value: "ask" },
            { name: "Code", value: "code" },
        ]);

        const report = opened[0]?.capabilities;

        expect(report?.groups.identity?.models).toEqual([
            { id: "fast", name: "Fast" },
            { id: "deep", name: "Deep" },
        ]);
        expect(isAvailable(capabilityOf(report, "identity.reasoningEffort"))).toBe(true);
        // The session's modes are not permission modes the runner enforces, so they are not reported as such.
        expect(report?.groups.permissions?.modes ?? []).toEqual([]);
    });

    it("reports the legacy states to the host, but not as capabilities: the agent cannot change them", async () => {
        const { opened, states } = await start("legacy-modes");

        expect(states).toEqual([
            { models: { available: [{ id: "m1", name: "M1" }], current: "m1" }, modes: { available: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }], current: "ask" } },
        ]);
        expect(opened[0]?.capabilities?.groups.identity?.models).toEqual([]);
        expect(opened[0]?.capabilities?.groups.permissions?.modes ?? []).toEqual([]);
    });

    it("reports nothing, and no capability, for an agent that offers none", async () => {
        const { opened, states } = await start("handshake-and-prompt");

        expect(states).toEqual([]);
        expect(opened[0]?.capabilities?.groups.identity?.models).toEqual([]);
        expect(isAvailable(capabilityOf(opened[0]?.capabilities, "identity.reasoningEffort"))).toBe(false);
    });
});

describe("what the agent changes by itself", () => {
    it("follows a config_option_update and a current_mode_update", async () => {
        const { player, states, steps } = await start("options-and-change");

        await player.play(steps.slice(0, 2));
        await expect.poll(() => states.length).toBe(3);

        expect(states[1]?.configOptions?.find((option) => option.id === "effort")?.currentValue).toBe("low");
        expect(states[2]?.configOptions?.find((option) => option.id === "mode")?.currentValue).toBe("code");
    });
});

describe("setOption", () => {
    it("asks the agent with the frame the protocol defines, and takes the options from its answer", async () => {
        const { agent, player, session, states, steps } = await start("options-and-change");

        await player.play(steps.slice(0, 2));

        const change = session.setOption("model", "deep");

        await player.play(steps.slice(2, 4));
        await expect(change).resolves.toBeUndefined();

        const frame = agent.written.find((entry) => entry.method === "session/set_config_option");

        expect(acpSchema("SetSessionConfigOptionRequest").safeParse(frame?.params).success).toBe(true);

        const last = states.at(-1);

        expect(last?.configOptions?.find((option) => option.id === "model")?.currentValue).toBe("deep");
        expect(last?.configOptions?.find((option) => option.id === "mode")?.currentValue).toBe("code");
    });

    it("changes a mode of the legacy state with session/set_mode", async () => {
        const { agent, player, session, states, steps } = await start("legacy-modes");
        const change = session.setOption(undefined, "code");

        await player.play(steps);
        await expect(change).resolves.toBeUndefined();

        expect(acpSchema("SetSessionModeRequest").safeParse(agent.written.find((entry) => entry.method === "session/set_mode")?.params).success).toBe(true);
        expect(states.at(-1)?.modes?.current).toBe("code");
    });

    it("sends nothing for a value the agent did not offer", async () => {
        const { agent, session } = await start("options-and-change");
        const before = agent.written.length;

        await expect(session.setOption("model", "invented")).rejects.toThrow("the agent does not offer that choice");
        await expect(session.setOption("nothing", "fast")).rejects.toThrow("the agent does not offer that choice");
        // The legacy mode state does not count while the agent sends options.
        await expect(session.setOption(undefined, "code")).rejects.toThrow("the agent does not offer that choice");
        expect(agent.written).toHaveLength(before);
    });

    it("refuses with a fixed reason when the agent refuses, never its own words", async () => {
        const { player, session, states, steps } = await start("options-and-change");

        await player.play(steps.slice(0, 2));

        const first = session.setOption("model", "deep");

        await player.play(steps.slice(2, 4));
        await first;

        const count = states.length;
        const change = session.setOption("effort", "high");
        const refused = expect(change).rejects.toThrow("the agent did not accept the change");

        await player.play(steps.slice(4));
        await refused;
        await expect(change).rejects.not.toThrow(PRIVATE);
        // A refused change leaves what was reported as it was.
        expect(states).toHaveLength(count);
    });
});

describe("what the agent sends while the session opens, and what it takes away", () => {
    it("keeps options sent before the answer to session/new", async () => {
        const { states } = await start("options-before-answer");

        expect(states).toHaveLength(1);
        expect(states[0]?.configOptions?.map((option) => [option.id, option.currentValue])).toEqual([["model", "fast"]]);
    });

    it("refuses a change whose answer still lists the old value, and reports what the agent says is true", async () => {
        const { player, session, states, steps } = await start("options-mismatch");
        const change = session.setOption("model", "deep");
        const refused = expect(change).rejects.toThrow("the agent did not apply the change");

        await player.play(steps);
        await refused;
        expect(states.at(-1)?.configOptions?.[0]?.currentValue).toBe("fast");
    });

    it("sends an empty list when the agent removes its last option", async () => {
        const { player, states, steps } = await start("options-removed");

        await player.play(steps);
        await expect.poll(() => states.length).toBe(2);
        expect(states.at(-1)).toEqual({ configOptions: [] });
    });
});
