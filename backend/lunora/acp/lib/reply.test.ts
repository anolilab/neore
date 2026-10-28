import { describe, expect, it } from "vitest";

import { isForwardHostState } from "../../chat/streaming/persistent/host";
import { MAX_HOST_REPLY_CHARS } from "./constants";
import { appendChildEvent, appendToTranscript, buildHostReply, emptyTranscript } from "./reply";

const transcript = (text: string, reasoning = "") => {
    return { children: [], reasoning, text };
};

const RESTARTED = /restarted/u;
const STOPPED_SENDING = /stopped sending output/u;
const REMOVED = /was removed/u;

describe("buildHostReply", () => {
    it("saves a finished turn as a successful, unbilled reply", () => {
        expect(buildHostReply({ agentKey: "claude", reason: "finished", transcript: transcript("Done.", "thought") })).toEqual({
            finishReason: "stop",
            message: { content: [{ text: "Done.", type: "text" }], role: "assistant" },
            model: "claude",
            provider: "acp-host",
            providerMetadata: { neore: { billed: false, runtime: "acp-host" } },
            reasoning: "thought",
            status: "success",
        });
    });

    it("saves nothing for a finished or stopped turn that wrote nothing, but always records a failed one", () => {
        expect(buildHostReply({ agentKey: "claude", reason: "finished", transcript: transcript("") })).toBeNull();
        expect(buildHostReply({ agentKey: "claude", reason: "stopped", transcript: transcript("") })).toBeNull();
        expect(buildHostReply({ agentKey: "claude", error: "boom", reason: "failed", transcript: transcript("") })).toMatchObject({
            error: "boom",
            status: "failed",
        });
    });

    it("says an interrupted turn was cut off by a restart, whatever the host sent", () => {
        const reply = buildHostReply({ agentKey: "claude", error: "ignored", reason: "interrupted", transcript: transcript("half") });

        expect(reply).toMatchObject({ finishReason: "error", status: "failed" });
        expect(reply?.error).toMatch(RESTARTED);
        expect(reply?.message.content).toEqual([{ text: "half", type: "text" }]);
    });

    it("keeps a cancelled turn's text as a normal reply that ended early", () => {
        expect(buildHostReply({ agentKey: "claude", reason: "cancelled", transcript: transcript("so far") })).toMatchObject({
            finishReason: "other",
            status: "success",
        });
    });
});

describe("a timed-out or revoked turn", () => {
    it("is always saved as a failed reply, with a note of its own", () => {
        const timeout = buildHostReply({ agentKey: "claude", reason: "timeout", transcript: transcript("") });
        const revoked = buildHostReply({ agentKey: "claude", reason: "revoked", transcript: transcript("so far") });

        expect(timeout).toMatchObject({ finishReason: "error", status: "failed" });
        expect(timeout?.error).toMatch(STOPPED_SENDING);
        expect(revoked).toMatchObject({ finishReason: "error", status: "failed" });
        expect(revoked?.error).toMatch(REMOVED);
        expect(revoked?.message.content).toEqual([{ text: "so far", type: "text" }]);
    });
});

describe("appendToTranscript", () => {
    it("caps the reply on the backend, whatever the host sent", () => {
        const body = emptyTranscript();

        appendToTranscript(body, { text: "a".repeat(MAX_HOST_REPLY_CHARS) });
        appendToTranscript(body, { reasoning: "r", text: "b" });

        expect(body.text).toHaveLength(MAX_HOST_REPLY_CHARS);
        expect(body.text.endsWith("b")).toBe(false);
        expect(body.reasoning).toBe("r");
    });
});

describe("an agent's own children", () => {
    const text = (spawnId: string, value: string, field: "reasoning" | "text" = "text") => {
        return { field, kind: "child_text" as const, spawnId, text: value };
    };

    it("are kept per spawn call, in order, with their tools and how they ended", () => {
        const body = emptyTranscript();

        appendChildEvent(body, text("task1", "looking "));
        appendChildEvent(body, { id: "c1", kind: "child_tool", spawnId: "task1", status: "pending", title: "Read a.ts", toolKind: "read" });
        appendChildEvent(body, { id: "c1", kind: "child_tool", spawnId: "task1", status: "completed", title: "Read a.ts", toolKind: "read" });
        appendChildEvent(body, text("task1", "found it"));
        appendChildEvent(body, text("task2", "other"));
        appendChildEvent(body, { kind: "child_end", spawnId: "task1", status: "completed" });

        expect(body.children).toEqual([
            { reasoning: "", spawnId: "task1", status: "completed", text: "looking found it", tools: [{ id: "c1", status: "completed", title: "Read a.ts", toolKind: "read" }] },
            { reasoning: "", spawnId: "task2", text: "other", tools: [] },
        ]);
    });

    it("end once: a repeated end and anything after it change nothing, so nothing is kept twice", () => {
        const body = emptyTranscript();

        appendChildEvent(body, text("task1", "done"));
        appendChildEvent(body, { kind: "child_end", spawnId: "task1", status: "completed" });
        appendChildEvent(body, { kind: "child_end", spawnId: "task1", status: "failed", text: "again" });
        appendChildEvent(body, text("task1", " and more"));

        expect(body.children).toEqual([{ reasoning: "", spawnId: "task1", status: "completed", text: "done", tools: [] }]);
    });

    it("keep a completion's full text only for a child that streamed none", () => {
        const silent = emptyTranscript();
        const talkative = emptyTranscript();

        appendChildEvent(silent, { id: "c1", kind: "child_tool", spawnId: "t", status: "completed", title: "Read", toolKind: "read" });
        appendChildEvent(silent, { kind: "child_end", spawnId: "t", status: "completed", text: "Two files changed." });
        appendChildEvent(talkative, text("t", "Two files changed."));
        appendChildEvent(talkative, { kind: "child_end", spawnId: "t", status: "completed", text: "Two files changed." });

        expect(silent.children.at(0)?.text).toBe("Two files changed.");
        expect(talkative.children.at(0)?.text).toBe("Two files changed.");
    });

    it("are capped on the backend, whatever the host sent", () => {
        const body = emptyTranscript();

        appendChildEvent(body, text("t", "a".repeat(70_000)));

        for (let index = 0; index < 20; index += 1) {
            appendChildEvent(body, text(`spawn${String(index)}`, "x"));
        }

        expect(body.children.at(0)?.text).toHaveLength(64_000);
        expect(body.children).toHaveLength(16);
    });

    it("ride with the reply, and a turn that only had children still saves one", () => {
        const body = emptyTranscript();

        appendChildEvent(body, text("task1", "hello"));

        const reply = buildHostReply({ agentKey: "claude", reason: "finished", transcript: body });

        expect(reply?.providerMetadata.neore).toMatchObject({ billed: false, subagentTranscripts: [{ spawnId: "task1", text: "hello" }] });
        expect(buildHostReply({ agentKey: "claude", reason: "finished", transcript: emptyTranscript() })).toBeNull();
    });
});

describe("isForwardHostState", () => {
    it("moves forward only, skips allowed", () => {
        expect(isForwardHostState(undefined, "received")).toBe(true);
        expect(isForwardHostState("accepted", "running")).toBe(true);
        expect(isForwardHostState("running", "received")).toBe(false);
        expect(isForwardHostState("running", "running")).toBe(false);
        expect(isForwardHostState("running", "ended")).toBe(true);
        expect(isForwardHostState("ended", "running")).toBe(false);
    });
});
