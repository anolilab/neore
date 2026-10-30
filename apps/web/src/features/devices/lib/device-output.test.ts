import { describe, expect, it } from "vitest";

import { isFsTool, isShellTool, readFs, readShell } from "./device-output";

describe("readShell", () => {
    it("reads the command, exit code and truncation", () => {
        const view = readShell({ command: "ls", cwd: "/a" }, { exitCode: 2, ok: true, output: "boom", truncated: true });

        expect(view).toEqual({ command: "ls", cwd: "/a", error: undefined, exitCode: 2, output: "boom", truncated: true });
    });

    it("accepts JSON text input and a failed call with partial output", () => {
        const view = readShell('{"command":"x"}', { error: "timed out", ok: false, output: "half", status: "failed" });

        expect(view.command).toBe("x");
        expect(view.error).toBe("timed out");
        expect(view.exitCode).toBeUndefined();
        expect(view.output).toBe("half");
        expect(view.truncated).toBe(false);
    });

    it("survives garbage", () => {
        expect(readShell(undefined, undefined)).toMatchObject({ command: undefined, output: "", truncated: false });
    });
});

describe("tool names", () => {
    it("tells the tools apart", () => {
        expect(isShellTool("shell_run")).toBe(true);
        expect(isFsTool("fs_read")).toBe(true);
        expect(isFsTool("shell_run")).toBe(false);
    });
});

describe("readFs", () => {
    it("summarises a write", () => {
        const view = readFs("fs_write", {}, { ok: true, output: "wrote 2048 bytes to /a/b.txt" });

        expect(view?.rows).toEqual([
            { label: "path", value: "/a/b.txt" },
            { label: "bytes", value: "2.0 KB" },
        ]);
    });

    it("summarises a listing", () => {
        const output = JSON.stringify({
            entries: [
                { name: "src", type: "dir", size: 0 },
                { name: "a.ts", type: "file", size: 3 },
            ],
            path: "/p",
            truncated: true,
        });
        const view = readFs("fs_list", {}, { ok: true, output });

        expect(view).toEqual({
            body: "src/\na.ts",
            rows: [
                { label: "path", value: "/p" },
                { label: "entries", value: "2" },
            ],
            truncated: true,
        });
    });

    it("summarises a read and a binary read", () => {
        expect(readFs("fs_read", { path: "/f" }, { ok: true, output: "hello" })?.rows).toEqual([
            { label: "path", value: "/f" },
            { label: "size", value: "5 B" },
        ]);
        expect(readFs("fs_read", { path: "/f" }, { ok: true, output: "[binary file, 10 bytes]" })?.body).toBeUndefined();
    });

    it("returns null for anything unknown so the raw JSON shows", () => {
        expect(readFs("fs_list", {}, { ok: true, output: "not json" })).toBeNull();
        expect(readFs("fs_write", {}, { ok: true, output: "done" })).toBeNull();
        expect(readFs("fs_read", {}, { error: "x", ok: false })).toBeNull();
        expect(readFs("fs_other", {}, { ok: true, output: "x" })).toBeNull();
    });
});
