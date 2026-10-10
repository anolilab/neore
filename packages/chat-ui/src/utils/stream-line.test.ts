import { describe, expect, it } from "vitest";

import { parseStreamLine } from "./stream-line";

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

    it("does not read a malformed resume marker as a resume", () => {
        expect(parseStreamLine(JSON.stringify({ lastChunkIndex: -1, type: "resume" })).kind).toBe("chunk");
        expect(parseStreamLine(JSON.stringify({ lastChunkIndex: "4", type: "resume" })).kind).toBe("chunk");
    });
});
