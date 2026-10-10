import { describe, expect, it } from "vitest";

import { SANDBOX_FILE_TOOL_TYPES, sandboxOutputsOf } from "./sandbox-files";

describe("sandboxOutputsOf", () => {
    it("reads files and skipped files from a tool output", () => {
        const file = { mediaType: "image/png", name: "chart.png", size: 3, url: "https://example.test/k?sig=1" };

        expect(sandboxOutputsOf({ files: [file], skippedFiles: [{ name: "a.html", reason: "unsupported-type" }], stdout: "" })).toStrictEqual({
            files: [file],
            skippedFiles: [{ name: "a.html", reason: "unsupported-type" }],
        });
    });

    it("drops malformed entries and answers null when nothing is left", () => {
        expect(sandboxOutputsOf({ files: [{ name: "x" }, "y", null], skippedFiles: [{ name: "z", reason: "because" }] })).toBeNull();
        expect(sandboxOutputsOf({ stdout: "hi" })).toBeNull();
        expect(sandboxOutputsOf("text")).toBeNull();
        expect(sandboxOutputsOf(null)).toBeNull();
    });

    it("only applies to the sandbox tools", () => {
        expect(SANDBOX_FILE_TOOL_TYPES.has("tool-codeExecution")).toBe(true);
        expect(SANDBOX_FILE_TOOL_TYPES.has("tool-shellExecution")).toBe(true);
        expect(SANDBOX_FILE_TOOL_TYPES.has("tool-webSearch")).toBe(false);
    });
});
