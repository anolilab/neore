import { describe, expect, it } from "vitest";

import { isForwardHostState } from "../../chat/streaming/persistent/host";
import { MAX_HOST_REPLY_CHARS } from "./constants";
import { appendToTranscript, buildHostReply, emptyTranscript } from "./reply";

const transcript = (text: string, reasoning = "") => {
    return { reasoning, text };
};

const RESTARTED = /restarted/u;

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
