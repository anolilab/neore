import { describe, expect, it } from "vitest";

import { toCrashReport } from "./crash-report-scrub";

/** Sets the stack an engine would have recorded when the error was thrown. */
const withStack = <T extends Error>(error: T, stack: string): T => Object.assign(error, { stack });

describe("toCrashReport", () => {
    it("keeps the error name and the stack frames, and drops the message", () => {
        const error = withStack(
            new TypeError("the reply said: buy milk"),
            "TypeError: the reply said: buy milk\n    at renderRow (app/chat.tsx:10:4)\n    at flush (src/x.ts:2:1)",
        );

        const report = toCrashReport(error);

        expect(report).toEqual({
            name: "TypeError",
            stack: "    at renderRow (app/chat.tsx:10:4)\n    at flush (src/x.ts:2:1)",
        });
        expect(JSON.stringify(report)).not.toContain("buy milk");
    });

    it("omits the stack when the error has no frames", () => {
        const error = withStack(new RangeError("secret"), "RangeError: secret");

        expect(toCrashReport(error)).toEqual({ name: "RangeError" });
    });

    it("reports a thrown non-error value without reading it", () => {
        expect(toCrashReport("a string with a thread title")).toEqual({ name: "NonError" });
        expect(toCrashReport(undefined)).toEqual({ name: "NonError" });
    });

    it("falls back to Error when the name is empty", () => {
        const error = withStack(Object.assign(new Error("x"), { name: "" }), "Error: x\n    at f (a.ts:1:1)");

        expect(toCrashReport(error).name).toBe("Error");
    });
});
