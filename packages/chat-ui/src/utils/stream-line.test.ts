import { describe, expect, it } from "vitest";

import { parseStreamLine, readToolProgress } from "./stream-line";

describe(parseStreamLine, () => {
    it("reads text and reasoning from a relayed chunk", () => {
        expect(parseStreamLine(JSON.stringify({ reasoning: "Let me think.", text: "Hi." }))).toStrictEqual({
            kind: "chunk",
            reasoning: "Let me think.",
            text: "Hi.",
        });
    });

    it("treats a chunk without reasoning as text only", () => {
        // JSON.stringify drops `reasoning: undefined`, so the gateway sends `{ text }`.
        expect(parseStreamLine(JSON.stringify({ reasoning: undefined, text: "Hi." }))).toStrictEqual({ kind: "chunk", reasoning: "", text: "Hi." });
    });

    it("reads a reasoning-only chunk", () => {
        expect(parseStreamLine(JSON.stringify({ reasoning: "Step one.", text: "" }))).toStrictEqual({ kind: "chunk", reasoning: "Step one.", text: "" });
    });

    it("reads a group-chat speaker marker", () => {
        expect(parseStreamLine(JSON.stringify({ speaker: { name: "Writer", skillId: "s1" }, text: "" }))).toStrictEqual({
            kind: "chunk",
            reasoning: "",
            speaker: { name: "Writer", skillId: "s1" },
            text: "",
        });
    });

    it("reads a speaker marker that arrives with the new participant's first text", () => {
        expect(parseStreamLine(JSON.stringify({ reasoning: "Hmm.", speaker: { name: "Critic", skillId: "s2" }, text: "No." }))).toStrictEqual({
            kind: "chunk",
            reasoning: "Hmm.",
            speaker: { name: "Critic", skillId: "s2" },
            text: "No.",
        });
    });

    it("reads a steering restart marker, and nothing but `true` as one", () => {
        expect(parseStreamLine(JSON.stringify({ restart: true, text: "" }))).toStrictEqual({ kind: "chunk", reasoning: "", restart: true, text: "" });
        expect(parseStreamLine(JSON.stringify({ restart: "yes", text: "Hi." }))).toStrictEqual({ kind: "chunk", reasoning: "", text: "Hi." });
    });

    it("ignores a speaker that is not an object", () => {
        expect(parseStreamLine(JSON.stringify({ speaker: "Writer", text: "Hi." }))).toStrictEqual({ kind: "chunk", reasoning: "", text: "Hi." });
    });

    it("ignores a malformed speaker", () => {
        expect(parseStreamLine(JSON.stringify({ speaker: { name: 1 }, text: "Hi." }))).toStrictEqual({ kind: "chunk", reasoning: "", text: "Hi." });
    });

    it("surfaces gateway error objects", () => {
        expect(parseStreamLine(JSON.stringify({ error: "Stream relay error" }))).toStrictEqual({ error: "Stream relay error", kind: "error" });
    });

    it("falls back to the raw line when it is not JSON", () => {
        expect(parseStreamLine("plain text")).toStrictEqual({ kind: "chunk", reasoning: "", text: "plain text" });
    });

    it("falls back to the raw line for a JSON primitive", () => {
        expect(parseStreamLine("42")).toStrictEqual({ kind: "chunk", reasoning: "", text: "42" });
    });

    it("reads the resume marker as a position, not a chunk", () => {
        expect(parseStreamLine(JSON.stringify({ lastChunkIndex: 40, type: "resume" }))).toStrictEqual({ kind: "resume", lastChunkIndex: 40 });
    });

    it("reads the end marker as the end of the reply, not a chunk", () => {
        expect(parseStreamLine(JSON.stringify({ type: "end" }))).toStrictEqual({ kind: "end" });
    });

    it("does not read a malformed resume marker as a resume", () => {
        expect(parseStreamLine(JSON.stringify({ lastChunkIndex: -1, type: "resume" })).kind).toBe("chunk");
        expect(parseStreamLine(JSON.stringify({ lastChunkIndex: "4", type: "resume" })).kind).toBe("chunk");
    });
});

describe("toolProgress", () => {
    const tool = { serverName: "Docs", toolCallId: "call_1", toolName: "index" };

    it("reads a progress report relayed on a chunk", () => {
        expect(parseStreamLine(JSON.stringify({ text: "", toolProgress: { ...tool, message: "Reading", progress: 2, total: 8 } }))).toStrictEqual({
            kind: "chunk",
            reasoning: "",
            text: "",
            toolProgress: { ...tool, message: "Reading", progress: 2, total: 8 },
        });
    });

    it("reads the end of a call", () => {
        expect(parseStreamLine(JSON.stringify({ text: "", toolProgress: { ...tool, ended: true } }))).toMatchObject({ toolProgress: { ...tool, ended: true } });
    });

    it("treats a total that is missing, zero or not finite as unknown", () => {
        for (const total of [undefined, 0, -1, "8", null]) {
            expect(readToolProgress({ ...tool, progress: 1, total })).toStrictEqual({ ...tool, progress: 1 });
        }
    });

    it("drops a report whose progress is unusable, and cuts a long message", () => {
        expect(readToolProgress({ ...tool, progress: -1 })).toBeUndefined();
        expect(readToolProgress({ ...tool, progress: "1" })).toBeUndefined();
        expect(readToolProgress({ progress: 1 })).toBeUndefined();
        expect(readToolProgress({ ...tool, message: "x".repeat(900), progress: 1 })?.message).toHaveLength(200);
    });

    it("strips control characters and bidi overrides and isolates from the message", () => {
        expect(readToolProgress({ ...tool, message: "a\u0007b\u202Ec\u2066d\u2069e", progress: 1 })?.message).toBe("abcde");
        expect(readToolProgress({ ...tool, message: "page 1\r\npage 2", progress: 1 })?.message).toBe("page 1 page 2");
        expect(readToolProgress({ ...tool, message: "\u202E\u2066", progress: 1 })).toStrictEqual({ ...tool, progress: 1 });
    });

    it("cuts the message by code point, so a surrogate pair is never split", () => {
        const message = readToolProgress({ ...tool, message: "😀".repeat(300), progress: 1 })?.message;

        expect(message).toBe("😀".repeat(200));
    });

    it("leaves a chunk without it exactly as before", () => {
        expect(parseStreamLine(JSON.stringify({ text: "Hi." }))).toStrictEqual({ kind: "chunk", reasoning: "", text: "Hi." });
    });
});
