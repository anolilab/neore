import { describe, expect, it } from "vitest";

import { isForwardHostState } from "../../chat/streaming/persistent/host";
import { MAX_HOST_REPLY_CHARS } from "./constants";
import type { HostMedia } from "./reply";
import { addMediaToTranscript, appendChildEvent, appendToTranscript, buildHostReply, emptyTranscript } from "./reply";

const transcript = (text: string, reasoning = "", media: HostMedia[] = []) => {
    return { children: [], media, reasoning, text };
};

const HOST_TEXT = { neore: { runner: "host" } };
const CODE_NAME_THEN_SIZE = /^`[^`\n]*` \(/u;
const RESTARTED = /restarted/u;
const STOPPED_SENDING = /stopped sending output/u;
const REMOVED = /was removed/u;

describe("buildHostReply with changes", () => {
    const changes = { files: [{ added: 1, path: "a.ts", removed: 0 }], patch: "+x\n" };

    it("keeps what the turn changed on the reply, even when the agent said nothing", () => {
        expect(buildHostReply({ agentKey: "claude", changes, reason: "finished", transcript: transcript("") })).toMatchObject({
            message: { content: [], role: "assistant" },
            providerMetadata: { neore: { billed: false, hostChanges: changes, runtime: "acp-host" } },
            status: "success",
        });
    });

    it("adds nothing to a reply that changed nothing", () => {
        expect(buildHostReply({ agentKey: "claude", reason: "finished", transcript: transcript("Done.") })?.providerMetadata.neore).not.toHaveProperty(
            "hostChanges",
        );
    });
});

describe("buildHostReply", () => {
    it("saves a finished turn as a successful, unbilled reply", () => {
        expect(buildHostReply({ agentKey: "claude", reason: "finished", transcript: transcript("Done.", "thought") })).toEqual({
            finishReason: "stop",
            message: { content: [{ providerMetadata: HOST_TEXT, text: "Done.", type: "text" }], role: "assistant" },
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
        expect(reply?.message.content).toEqual([{ providerMetadata: HOST_TEXT, text: "half", type: "text" }]);
    });

    it("keeps a cancelled turn's text as a normal reply that ended early", () => {
        expect(buildHostReply({ agentKey: "claude", reason: "cancelled", transcript: transcript("so far") })).toMatchObject({
            finishReason: "other",
            status: "success",
        });
    });
});

describe("a reply's files", () => {
    const attached: HostMedia = { contentType: "image/png", fileId: "file1", name: "chart.png", size: 1000, storageKey: `agent-files/${"a".repeat(64)}` };

    it("carries an attached file as a storage reference and counts it on the message", () => {
        const reply = buildHostReply({ agentKey: "claude", reason: "finished", transcript: transcript("Here.", "", [attached, { ...attached }]) });

        expect(reply?.message.content).toEqual([
            { providerMetadata: HOST_TEXT, text: "Here.", type: "text" },
            { data: `storage:agent-files/${"a".repeat(64)}`, filename: "chart.png", mediaType: "image/png", type: "file" },
            { data: `storage:agent-files/${"a".repeat(64)}`, filename: "chart.png", mediaType: "image/png", type: "file" },
        ]);
        // One count per distinct file, however often it is shown.
        expect(reply).toMatchObject({ fileIds: ["file1"] });
    });

    it("replaces an image that became an attachment by its alt text, and leaves every other Markdown alone", () => {
        const reply = buildHostReply({
            agentKey: "claude",
            reason: "finished",
            transcript: transcript('Look: ![the chart](out/my%20chart.png) and ![x](https://example.test/a.png) and ![y](<other.png> "t")', "", [
                { ...attached, reference: "out/my chart.png" },
            ]),
        });
        const [text] = reply?.message.content ?? [];

        expect(text).toMatchObject({ text: 'Look: the chart and ![x](https://example.test/a.png) and ![y](<other.png> "t")' });
    });

    it("offers an image over the inline cap, and a document, as a download with its size", () => {
        const large: HostMedia = { ...attached, name: "photo.png", size: 12 * 1024 * 1024 };
        const doc: HostMedia = {
            ...attached,
            contentType: "application/pdf",
            fileId: "file2",
            name: "report.pdf",
            size: 2048,
            storageKey: `agent-files/${"c".repeat(64)}`,
        };
        const reply = buildHostReply({ agentKey: "claude", reason: "finished", transcript: transcript("", "", [large, doc]) });

        expect(reply?.message.content).toEqual([
            { data: `storage:agent-files/${"a".repeat(64)}`, filename: "photo.png", mediaType: "application/octet-stream", type: "file" },
            { data: `storage:agent-files/${"c".repeat(64)}`, filename: "report.pdf", mediaType: "application/pdf", type: "file" },
            { providerMetadata: HOST_TEXT, text: "`photo.png` (12.0 MiB) is attached as a file.\n\n`report.pdf` (2 KiB) is attached as a file.", type: "text" },
        ]);
    });

    it("saves a turn whose only output is a file", () => {
        expect(buildHostReply({ agentKey: "claude", reason: "finished", transcript: transcript("", "", [attached]) })).not.toBeNull();
    });

    it("names a file over the cap with its size, and attaches nothing", () => {
        const reply = buildHostReply({ agentKey: "claude", reason: "finished", transcript: transcript("", "", [{ name: "big.pdf", size: 30 * 1024 * 1024 }]) });

        expect(reply?.message.content).toEqual([
            { providerMetadata: HOST_TEXT, text: "`big.pdf` (30.0 MiB) is over the 20.0 MiB limit and was not attached.", type: "text" },
        ]);
        expect(reply).not.toHaveProperty("fileIds");
    });

    it("says a file within the cap that did not finalize could not be attached", () => {
        const reply = buildHostReply({ agentKey: "claude", reason: "finished", transcript: transcript("", "", [{ name: "a.png", size: 2048 }]) });

        expect(reply?.message.content).toEqual([{ providerMetadata: HOST_TEXT, text: "`a.png` (2 KiB) could not be attached.", type: "text" }]);
    });

    it("never lets a file name become Markdown", () => {
        const reply = buildHostReply({
            agentKey: "claude",
            reason: "finished",
            transcript: transcript("", "", [{ name: "x`![a](https://evil.example/?q=1)\n", size: 1 }]),
        });
        const [note] = reply?.message.content ?? [];

        expect(note).toMatchObject({ text: expect.stringMatching(CODE_NAME_THEN_SIZE) });
    });

    it("keeps no more files than one turn may attach", () => {
        const kept = emptyTranscript();

        for (let index = 0; index < 20; index += 1) {
            addMediaToTranscript(kept, { name: `f${String(index)}.png`, size: 1 });
        }

        expect(kept.media).toHaveLength(8);
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
        expect(revoked?.message.content).toEqual([{ providerMetadata: HOST_TEXT, text: "so far", type: "text" }]);
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
            {
                reasoning: "",
                spawnId: "task1",
                status: "completed",
                text: "looking found it",
                tools: [{ id: "c1", status: "completed", title: "Read a.ts", toolKind: "read" }],
            },
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

    it("share one budget across all of them, so a child-heavy turn cannot outgrow the reply's row", () => {
        const body = emptyTranscript();

        for (let index = 0; index < 20; index += 1) {
            const spawnId = `spawn${String(index)}`;

            appendChildEvent(body, text(spawnId, "t".repeat(64_000)));
            appendChildEvent(body, text(spawnId, "r".repeat(64_000), "reasoning"));

            for (let tool = 0; tool < 60; tool += 1) {
                appendChildEvent(body, { id: `c${String(tool)}`, kind: "child_tool", spawnId, status: "completed", title: "T".repeat(500), toolKind: "read" });
            }

            appendChildEvent(body, { kind: "child_end", spawnId, status: "completed", text: "e".repeat(64_000) });
        }

        const chars = body.children.reduce((sum, child) => sum + child.text.length + child.reasoning.length, 0);
        const reply = buildHostReply({ agentKey: "claude", reason: "finished", transcript: body });

        expect(chars).toBeLessThanOrEqual(128_000);
        expect(body.children.reduce((sum, child) => sum + child.tools.length, 0)).toBeLessThanOrEqual(200);
        expect(JSON.stringify(reply?.providerMetadata).length).toBeLessThan(400_000);
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
