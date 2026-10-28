/**
 * What a turn changed (plan §4.9, slice S9): only files the agent's own tool calls name, frozen when the call
 * completes, nothing outside the approved folder read, and a patch that does not fit keeps the file list.
 */
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FileIo } from "./changes";
import { MAX_PATCH_BYTES, TurnChanges } from "./changes";
import { MAX_SUMMARY_FILES, turnEndEvent, wireBytes } from "./host-events";
import { unifiedDiff } from "./unified-diff";

let temporary: string;
let work: string;
/** Every file the recorder asked to read, as the path it passed to the file system. */
let reads: string[];

const io = (): FileIo => {
    return {
        lstat,
        readFile: async (file) => {
            reads.push(file);

            return await readFile(file);
        },
        realpath: async (file) => await realpath(file),
    };
};

const recorder = () => new TurnChanges(work, (text) => text, io());

const diffCall = (id: string, file: string, oldText: string | null, newText: string, status = "completed") => {
    return { content: [{ newText, oldText, path: path.isAbsolute(file) ? file : path.join(work, file), type: "diff" }], status, toolCallId: id };
};

beforeEach(async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "neore-changes-"));
    work = path.join(temporary, "work");
    reads = [];
    await mkdir(work);
});

afterEach(async () => {
    await rm(temporary, { force: true, recursive: true });
});

describe("a unified diff", () => {
    it("counts added and removed lines and prints hunks with context", () => {
        const diff = unifiedDiff("a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n", "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\n");

        expect(diff).toMatchObject({ added: 2, removed: 1 });
        expect(diff.patch).toBe(
            ["--- a/a.txt", "+++ b/a.txt", "@@ -1,8 +1,9 @@", " one", " two", "-three", "+THREE", " four", " five", " six", " seven", " eight", "+nine", ""].join("\n"),
        );
    });

    it("keeps two changes apart when more than twice the context lies between them", () => {
        const lines = Array.from({ length: 20 }, (_, index) => `l${String(index)}`);
        const changed = lines.map((line, index) => index === 1 || index === 18 ? line.toUpperCase() : line);
        const { patch } = unifiedDiff("a", `${lines.join("\n")}\n`, `${changed.join("\n")}\n`);

        expect(patch.match(/^@@/gm)).toHaveLength(2);
        expect(patch).toContain("@@ -1,5 +1,5 @@");
        expect(patch).toContain("@@ -16,5 +16,5 @@");
    });

    it("marks a created file against /dev/null and notes a missing final newline", () => {
        expect(unifiedDiff("n.txt", null, "a\nb")).toEqual({
            added: 2,
            patch: "--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n",
            removed: 0,
        });
    });

    it("sees nothing in two identical texts", () => {
        expect(unifiedDiff("a", "same\n", "same\n")).toEqual({ added: 0, patch: "", removed: 0 });
    });
});

describe("the files a turn wrote", () => {
    it("lists every file a completed diff names, with its line counts, in path order", async () => {
        const changes = recorder();

        changes.note({ id: "1", kind: "edit", status: "completed" }, diffCall("1", "src/b.ts", "a\nb\nc\n", "a\nB\nc\nd\n"));
        changes.note({ id: "2", kind: "edit", status: "completed" }, diffCall("2", "a.ts", null, "x\ny\n"));

        const summary = await changes.summary();

        expect(summary?.files).toEqual([
            { added: 2, path: "a.ts", removed: 0 },
            { added: 2, path: "src/b.ts", removed: 1 },
        ]);
        expect(summary?.patch).toContain("+++ b/src/b.ts");
        expect(summary?.patch).toContain("--- /dev/null");
        // Diff content carries both sides: nothing was read.
        expect(reads).toEqual([]);
    });

    it("joins two calls on one file: the first earlier text, the last later text", async () => {
        const changes = recorder();

        changes.note({ id: "1", kind: "edit", status: "completed" }, diffCall("1", "a.ts", "one\n", "two\n"));
        changes.note({ id: "2", kind: "edit", status: "completed" }, diffCall("2", "a.ts", "two\n", "three\n"));

        const summary = await changes.summary();

        expect(summary?.files).toEqual([{ added: 1, path: "a.ts", removed: 1 }]);
    });

    it("lists a file named by location from its earlier and later text, and not one edited beside it", async () => {
        await writeFile(path.join(work, "named.txt"), "old\n");
        await writeFile(path.join(work, "other.txt"), "untouched\n");

        const changes = recorder();
        const named = { kind: "edit", locations: [{ path: path.join(work, "named.txt") }], toolCallId: "1" };

        changes.note({ id: "1", kind: "edit", status: "pending" }, { ...named, status: "pending" });
        await expect.poll(() => reads.length).toBe(1);
        // The agent writes the file; somebody else edits another one in the same folder meanwhile.
        await writeFile(path.join(work, "named.txt"), "new\nmore\n");
        await writeFile(path.join(work, "other.txt"), "changed by somebody else\n");
        changes.note({ id: "1", kind: "edit", status: "completed" }, { status: "completed", toolCallId: "1" });

        const summary = await changes.summary();

        expect(summary?.files).toEqual([{ added: 2, path: "named.txt", removed: 1 }]);
        expect(reads.map((file) => path.basename(file))).not.toContain("other.txt");
    });

    it("lists nothing for a file edited in the folder that no tool call names", async () => {
        await writeFile(path.join(work, "other.txt"), "before\n");

        const changes = recorder();

        changes.note({ id: "1", kind: "read", status: "completed" }, { kind: "read", locations: [{ path: path.join(work, "other.txt") }], status: "completed", toolCallId: "1" });
        await writeFile(path.join(work, "other.txt"), "after\n");

        expect(await changes.summary()).toBeUndefined();
        expect(changes.active).toBe(false);
    });

    it("keeps the patch as it was when the call completed, whatever happens to the file later", async () => {
        await writeFile(path.join(work, "a.txt"), "old\n");

        const changes = recorder();
        const call = { kind: "edit", locations: [{ path: path.join(work, "a.txt") }], toolCallId: "1" };

        changes.note({ id: "1", kind: "edit", status: "pending" }, { ...call, status: "pending" });
        await expect.poll(() => reads.length).toBe(1);
        await writeFile(path.join(work, "a.txt"), "agent wrote this\n");
        changes.note({ id: "1", kind: "edit", status: "completed" }, { status: "completed", toolCallId: "1" });
        await expect.poll(() => reads.length).toBe(2);
        // Later edits, by the agent in another call or by anyone else, change nothing here.
        await writeFile(path.join(work, "a.txt"), "edited afterwards\nand again\nand again\n");
        changes.note({ id: "1", kind: "edit", status: "completed" }, { ...call, status: "completed" });

        const summary = await changes.summary();

        expect(summary?.files).toEqual([{ added: 1, path: "a.txt", removed: 1 }]);
        expect(summary?.patch).toContain("+agent wrote this");
        expect(summary?.patch).not.toContain("afterwards");

        changes.note({ id: "2", kind: "edit", status: "completed" }, diffCall("2", "late.ts", null, "x\n"));
        const again = await changes.summary();

        expect(again?.files.map((file) => file.path)).toEqual(["a.txt"]);
    });

    it("does not list a call that failed, was cancelled or was declined", async () => {
        const changes = recorder();

        for (const [id, status] of [["1", "failed"], ["2", "cancelled"], ["3", "declined"]] as const) {
            changes.note({ id, kind: "edit", status: "pending" }, diffCall(id, `${id}.ts`, null, "x\n", "pending"));
            changes.note({ id, kind: "edit", status }, { status, toolCallId: id });
            changes.note({ id, kind: "edit", status: "completed" }, { status: "completed", toolCallId: id });
        }

        expect(await changes.summary()).toBeUndefined();
    });

    it("leaves out a write it cannot attribute: a call already complete when first seen, a binary file", async () => {
        await writeFile(path.join(work, "late.txt"), "written already\n");
        await writeFile(path.join(work, "bin.dat"), Buffer.from([0, 1, 2]));

        const changes = recorder();

        changes.note({ id: "1", kind: "edit", status: "completed" }, { kind: "edit", locations: [{ path: path.join(work, "late.txt") }], status: "completed", toolCallId: "1" });
        changes.note({ id: "2", kind: "edit", status: "pending" }, { kind: "edit", locations: [{ path: path.join(work, "bin.dat") }], status: "pending", toolCallId: "2" });
        changes.note({ id: "2", kind: "edit", status: "completed" }, { status: "completed", toolCallId: "2" });

        expect(await changes.summary()).toBeUndefined();
    });
});

describe("a write outside the approved folder", () => {
    it("is not listed and not read: a path above, an absolute path elsewhere, and a symlink that leaves", async () => {
        await writeFile(path.join(temporary, "secret.txt"), "secret\n");
        await writeFile(path.join(work, "inside.txt"), "ok\n");
        await symlink(path.join(temporary, "secret.txt"), path.join(work, "link.txt"));
        await symlink(temporary, path.join(work, "linkdir"));

        const changes = recorder();
        const escapes = [
            path.join(work, "..", "secret.txt"),
            path.join(temporary, "secret.txt"),
            "../secret.txt",
            path.join(work, "link.txt"),
            path.join(work, "linkdir", "secret.txt"),
        ];

        for (const [index, file] of escapes.entries()) {
            const id = String(index);

            changes.note({ id, kind: "edit", status: "pending" }, { kind: "edit", locations: [{ path: file }], status: "pending", toolCallId: id });
            changes.note({ id: `d${id}`, kind: "edit", status: "completed" }, diffCall(`d${id}`, file, "a\n", "b\n"));
            changes.note({ id, kind: "edit", status: "completed" }, { status: "completed", toolCallId: id });
        }

        expect(await changes.summary()).toBeUndefined();
        // Nothing outside the folder was opened, and the symlinks were resolved before anything was read.
        expect(reads.every((file) => file.startsWith(temporary) && !file.endsWith("secret.txt"))).toBe(true);
    });

    it("refuses a path that could forge a line of the patch", async () => {
        const changes = recorder();

        changes.note({ id: "1", kind: "edit", status: "completed" }, diffCall("1", "a.ts\n+++ b/evil", null, "x\n"));

        expect(await changes.summary()).toBeUndefined();
    });
});

describe("a patch that does not fit", () => {
    const big = (lines: number): string => Array.from({ length: lines }, (_, index) => `line ${String(index)} of a long file`).join("\n");

    it("keeps the file list and the counts and says the diff is too large", async () => {
        const changes = recorder();

        changes.note({ id: "1", kind: "edit", status: "completed" }, diffCall("1", "big.ts", null, `${big(8000)}\n`));
        changes.note({ id: "2", kind: "edit", status: "completed" }, diffCall("2", "small.ts", "a\n", "b\n"));

        const summary = await changes.summary();

        expect(summary?.files).toEqual([
            { added: 8000, path: "big.ts", removed: 0 },
            { added: 1, path: "small.ts", removed: 1 },
        ]);
        expect(summary?.patch).toEqual({ tooLarge: true });
    });

    it("a patch just under the cap is kept", async () => {
        const changes = recorder();
        const lines = Math.floor(MAX_PATCH_BYTES / 40);

        changes.note({ id: "1", kind: "edit", status: "completed" }, diffCall("1", "ok.ts", null, `${big(lines).slice(0, MAX_PATCH_BYTES - 2000)}\n`));

        const summary = await changes.summary();

        expect(typeof summary?.patch).toBe("string");
    });

    it("the turn's end event always fits one post: the patch gives way first, then the tail of the files", () => {
        const files = Array.from({ length: MAX_SUMMARY_FILES + 20 }, (_, index) => {
            return { added: 1, path: `${"d/".repeat(200)}${String(index)}.ts`, removed: 0 };
        });
        const event = turnEndEvent("finished", undefined, { files, patch: "+x\n".repeat(30_000) });

        expect(wireBytes(event)).toBeLessThanOrEqual(150_000);
        expect(event.summary?.patch).toEqual({ tooLarge: true });
        expect(event.summary?.files.length).toBeGreaterThan(0);
        expect(event.summary?.files.length).toBeLessThanOrEqual(MAX_SUMMARY_FILES);

        const small = turnEndEvent("finished", undefined, { files: [{ added: 1, path: "a.ts", removed: 0 }], patch: "+x\n" });

        expect(small.summary).toEqual({ files: [{ added: 1, path: "a.ts", removed: 0 }], patch: "+x\n" });
        expect(turnEndEvent("finished", undefined, undefined)).toEqual({ kind: "turn_end", reason: "finished" });
    });
});
