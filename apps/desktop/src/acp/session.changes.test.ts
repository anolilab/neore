/**
 * A session hands its observer what a turn changed, from the agent's own tool calls (plan §4.9, slice S9): files
 * the calls name, with line counts, and nothing else in the folder.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionObserver, TurnSummary } from "./host-events";
import type { PermissionGate } from "./permission";
import { AgentSession } from "./session";
import { memoryAgent, readTranscript, transcriptPlayer } from "./testing/harness";

/** Answers after a moment, as a person would: the file's earlier text is read while the request waits. */
const allow: PermissionGate = {
    ask: async () => {
        await new Promise((resolve) => {
            setTimeout(resolve, 100);
        });

        return { optionId: "allow", outcome: "selected" };
    },
    cancelSession: () => {},
};

let work: string;

beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), "neore-session-changes-"));
});

afterEach(async () => {
    await rm(work, { force: true, recursive: true });
});

const start = async () => {
    const ends: { reason: string; summary?: TurnSummary }[] = [];
    const observer: SessionObserver = {
        permissionRequested: () => {},
        permissionResolved: () => {},
        sessionEnded: () => {},
        sessionOpened: () => {},
        text: () => {},
        thought: () => {},
        tool: () => {},
        turnEnded: (_session, _turn, reason, _error, summary) => {
            ends.push({ reason, ...summary !== undefined && { summary } });
        },
        turnStarted: () => {},
    };
    const agent = memoryAgent();
    const session = new AgentSession({
        agentKey: "example",
        agentLabel: "Example",
        appVersion: "9.9.9",
        folder: work,
        gate: allow,
        hostInfo: { agentKey: "example", agentLabel: "Example", folderId: "f1", folderLabel: "neore" },
        observer,
        onChange: () => {},
        process: agent.process,
    });
    const player = transcriptPlayer(agent);
    const steps = readTranscript("handshake-and-prompt");
    const sessionNew = steps[2] as { out: { params: { cwd: string } } };

    sessionNew.out.params.cwd = work;
    await Promise.all([session.start(), player.play(steps.slice(0, 4))]);
    session.send("say hi");
    await player.play(steps.slice(4, 5));

    const update = (body: Record<string, unknown>): void => {
        agent.say({ method: "session/update", params: { sessionId: "sess_1", update: body } });
    };

    return { agent, ends, player, session, steps, update };
};

describe("a turn's changes, told to the observer", () => {
    it("lists the two files a turn wrote with their counts, and leaves out a file somebody else edited", async () => {
        await writeFile(path.join(work, "neighbour.txt"), "before\n");

        const { ends, player, session, steps, update } = await start();

        update({ content: [{ newText: "one\ntwo\n", oldText: null, path: path.join(work, "a.txt"), type: "diff" }], kind: "edit", sessionUpdate: "tool_call", status: "pending", title: "Write a", toolCallId: "c1" });
        update({ sessionUpdate: "tool_call_update", status: "completed", toolCallId: "c1" });
        await writeFile(path.join(work, "neighbour.txt"), "after, by somebody else\n");
        update({ content: [{ newText: "x\nY\n", oldText: "x\ny\nz\n", path: path.join(work, "sub", "b.txt"), type: "diff" }], kind: "edit", sessionUpdate: "tool_call", status: "in_progress", title: "Edit b", toolCallId: "c2" });
        update({ sessionUpdate: "tool_call_update", status: "completed", toolCallId: "c2" });
        await player.play(steps.slice(-1));
        await expect.poll(() => ends.length).toBe(1);

        expect(ends[0]?.reason).toBe("end_turn");
        expect(ends[0]?.summary?.files).toEqual([
            { added: 2, path: "a.txt", removed: 0 },
            { added: 1, path: "sub/b.txt", removed: 2 },
        ]);
        expect(typeof ends[0]?.summary?.patch).toBe("string");
        expect(session.snapshot().status).toBe("idle");
    });

    it("reads the earlier text of a path a permission request names, before the user answers", async () => {
        await writeFile(path.join(work, "c.txt"), "old\n");

        const { agent, ends, player, steps, update } = await start();
        const file = path.join(work, "c.txt");

        update({ kind: "edit", locations: [{ path: file }], sessionUpdate: "tool_call", status: "pending", title: "Edit c", toolCallId: "c1" });
        agent.say({
            id: 90,
            method: "session/request_permission",
            params: {
                options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
                sessionId: "sess_1",
                toolCall: { kind: "edit", locations: [{ path: file }], toolCallId: "c1" },
            },
        });
        await expect.poll(() => agent.written.some((frame) => frame.id === 90)).toBe(true);
        await writeFile(file, "new\n");
        update({ sessionUpdate: "tool_call_update", status: "completed", toolCallId: "c1" });
        await player.play(steps.slice(-1));
        await expect.poll(() => ends.length).toBe(1);

        expect(ends[0]?.summary?.files).toEqual([{ added: 1, path: "c.txt", removed: 1 }]);
    });

    it("says nothing of changes for a turn whose calls wrote nothing, and for an edit the user declined", async () => {
        const { ends, player, steps, update } = await start();

        update({ content: [{ newText: "x\n", oldText: null, path: path.join(work, "no.txt"), type: "diff" }], kind: "edit", sessionUpdate: "tool_call", status: "pending", title: "Write", toolCallId: "c1" });
        update({ sessionUpdate: "tool_call_update", status: "failed", toolCallId: "c1" });
        await player.play(steps.slice(-1));
        await expect.poll(() => ends.length).toBe(1);

        expect(ends[0]).toEqual({ reason: "end_turn" });
    });
});
