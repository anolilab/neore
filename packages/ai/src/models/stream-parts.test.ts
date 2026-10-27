import { describe, expect, it } from "vitest";

import { isVisiblePart } from "./stream-parts";

describe("isVisiblePart", () => {
    it("is false for structural parts and empty deltas", () => {
        for (const part of [
            { type: "stream-start" },
            { type: "response-metadata" },
            { type: "text-start" },
            { type: "reasoning-start" },
            { delta: "", type: "text-delta" },
            { delta: "", type: "reasoning-delta" },
            { delta: "", type: "tool-input-delta" },
            { type: "error" },
        ]) {
            expect(isVisiblePart(part)).toBe(false);
        }
    });

    it("is true for text, reasoning and tool-argument deltas with characters, tool calls, files and the finish", () => {
        for (const part of [
            { delta: "a", type: "text-delta" },
            { delta: "a", type: "reasoning-delta" },
            { delta: "{", type: "tool-input-delta" },
            { type: "tool-call" },
            { type: "file" },
            { type: "finish" },
        ]) {
            expect(isVisiblePart(part)).toBe(true);
        }
    });
});
