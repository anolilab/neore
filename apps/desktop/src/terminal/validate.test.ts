import { describe, expect, it } from "vitest";

import { MAX_INPUT_CHARS, readAck, readCopy, readInput, readSize } from "./validate";

describe("terminal input checks", () => {
    it("accepts a sane size and refuses anything else", () => {
        expect(readSize({ cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 });

        for (const bad of [null, "80x24", { cols: 0, rows: 24 }, { cols: 80.5, rows: 24 }, { cols: 80, rows: 100_000 }, { cols: "80", rows: 24 }, { cols: 80 }]) {
            expect(() => readSize(bad)).toThrow("terminal:");
        }
    });

    it("accepts text up to the cap and refuses empty, oversized or non-text input", () => {
        expect(readInput("ls\n")).toBe("ls\n");
        expect(() => readInput("")).toThrow("input is invalid");
        expect(() => readInput("x".repeat(MAX_INPUT_CHARS + 1))).toThrow("input is invalid");
        expect(() => readInput(42)).toThrow("input is invalid");
    });

    it("bounds a copy and an acknowledgement", () => {
        expect(readCopy("")).toBe("");
        expect(() => readCopy(1)).toThrow("text is invalid");
        expect(readAck(10)).toBe(10);
        expect(() => readAck(-1)).toThrow("ack is invalid");
        expect(() => readAck(1.5)).toThrow("ack is invalid");
    });
});
