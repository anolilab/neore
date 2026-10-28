import { describe, expect, it } from "vitest";

import { isForwardHostState } from "../../chat/streaming/persistent/host";
import { MAX_HOST_REPLY_CHARS } from "./constants";
import type { HostMedia } from "./reply";
import { addMediaToTranscript, appendToTranscript, buildHostReply, emptyTranscript } from "./reply";

const transcript = (text: string, reasoning = "", media: HostMedia[] = []) => {
    return { media, reasoning, text };
};

const HOST_TEXT = { neore: { runner: "host" } };
const CODE_NAME_THEN_SIZE = /^`[^`\n]*` \(/u;
const RESTARTED = /restarted/u;
const STOPPED_SENDING = /stopped sending output/u;
const REMOVED = /was removed/u;

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
            transcript: transcript("Look: ![the chart](out/my%20chart.png) and ![x](https://example.test/a.png) and ![y](<other.png> \"t\")", "", [
                { ...attached, reference: "out/my chart.png" },
            ]),
        });
        const [text] = reply?.message.content ?? [];

        expect(text).toMatchObject({ text: "Look: the chart and ![x](https://example.test/a.png) and ![y](<other.png> \"t\")" });
    });

    it("offers an image over the inline cap, and a document, as a download with its size", () => {
        const large: HostMedia = { ...attached, name: "photo.png", size: 12 * 1024 * 1024 };
        const doc: HostMedia = { ...attached, contentType: "application/pdf", fileId: "file2", name: "report.pdf", size: 2048, storageKey: `agent-files/${"c".repeat(64)}` };
        const reply = buildHostReply({ agentKey: "claude", reason: "finished", transcript: transcript("", "", [large, doc]) });

        expect(reply?.message.content).toEqual([
            { data: `storage:agent-files/${"a".repeat(64)}`, filename: "photo.png", mediaType: "application/octet-stream", type: "file" },
            { data: `storage:agent-files/${"c".repeat(64)}`, filename: "report.pdf", mediaType: "application/pdf", type: "file" },
            { providerMetadata: HOST_TEXT, text: "`photo.png` (12.0 MB) is attached as a file.\n\n`report.pdf` (2 KB) is attached as a file.", type: "text" },
        ]);
    });

    it("saves a turn whose only output is a file", () => {
        expect(buildHostReply({ agentKey: "claude", reason: "finished", transcript: transcript("", "", [attached]) })).not.toBeNull();
    });

    it("names a file over the cap with its size, and attaches nothing", () => {
        const reply = buildHostReply({ agentKey: "claude", reason: "finished", transcript: transcript("", "", [{ name: "big.pdf", size: 30 * 1024 * 1024 }]) });

        expect(reply?.message.content).toEqual([{ providerMetadata: HOST_TEXT, text: "`big.pdf` (30.0 MB) is over the 20.0 MB limit and was not attached.", type: "text" }]);
        expect(reply).not.toHaveProperty("fileIds");
    });

    it("says a file within the cap that did not finalize could not be attached", () => {
        const reply = buildHostReply({ agentKey: "claude", reason: "finished", transcript: transcript("", "", [{ name: "a.png", size: 2048 }]) });

        expect(reply?.message.content).toEqual([{ providerMetadata: HOST_TEXT, text: "`a.png` (2 KB) could not be attached.", type: "text" }]);
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
