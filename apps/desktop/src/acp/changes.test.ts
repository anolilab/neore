/**
 * What a turn changed (plan §4.9, slice S9): only files the agent's own tool calls name, frozen when the call
 * completes, nothing outside the approved folder read, and a patch that does not fit keeps the file list.
 */
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FileIo } from "./changes";
import { MAX_PATCH_BYTES, TurnChanges } from "./changes";
import { FolderFiles, nodeIo, withoutVerbatimPrefix } from "./folder-files";
import { isSummaryPath, MAX_SUMMARY_FILES, turnEndEvent, wireBytes } from "./host-events";
import { DiffLimits, newDiffLimits, unifiedDiff } from "./unified-diff";

let temporary: string;
let work: string;
/** Every file the recorder asked to read, as the path it passed to the file system. */
let reads: string[];

const io = (): FileIo => {
    return {
        ...nodeIo,
        readRegular: async (file, maxBytes) => {
            reads.push(file);

            return await nodeIo.readRegular(file, maxBytes);
        },
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

    it("lets go of the earlier diff of a file when a later one in the same call is too big to keep", () => {
        const changes = recorder();
        const held = () => (changes as unknown as { held: number }).held;
        const huge = "x".repeat(1024 * 1024 + 1);

        changes.note({ id: "1", kind: "edit", status: "pending" }, diffCall("1", "a.ts", "one\n", "two\n", "pending"));
        expect(held()).toBeGreaterThan(0);
        changes.note({ id: "1", kind: "edit", status: "pending" }, diffCall("1", "a.ts", "one\n", huge, "pending"));
        expect(held()).toBe(0);
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

describe("a path the backend would refuse", () => {
    it("is checked with the backend's rules on the text that is sent", () => {
        const accepted = ["a.ts", "src/b.ts", "dir/with space.md", "a..b/c", "..hidden", "x".repeat(1024)];
        const refused = ["", "c:x.md", String.raw`C:\x`, String.raw`a\..\b`, String.raw`..\a`, "a/../b", "..", String.raw`\server\x`, "/etc/passwd", "a\nb", "a\u{0}b", "x".repeat(1025)];

        expect(accepted.filter((candidate) => !isSummaryPath(candidate))).toEqual([]);
        expect(refused.filter((candidate) => isSummaryPath(candidate))).toEqual([]);
    });

    it("is left out of the summary: a drive-like name, backslash segments, and a name that only fails once masked", async () => {
        await mkdir(path.join(work, "key"));

        const changes = new TurnChanges(work, (text) => text.replaceAll("key", ".."), io());

        for (const [id, file] of [["1", "c:x.md"], ["2", String.raw`a\..\b`], ["3", String.raw`\lead.md`], ["4", "key/x.md"], ["5", "fine.md"]] as const) {
            changes.note({ id, kind: "edit", status: "completed" }, diffCall(id, file, null, "x\n"));
        }

        const summary = await changes.summary();

        expect(summary?.files.map((file) => file.path)).toEqual(["fine.md"]);
        expect(summary?.patch).not.toContain("..");
    });

    it("never costs the turn its end: the event is sanitised whatever the summary holds", () => {
        const event = turnEndEvent("finished", undefined, {
            files: [
                { added: 1, path: "c:x.md", removed: 0 },
                { added: -1, path: "neg.md", removed: 0 },
                { added: 1.5, path: "frac.md", removed: 0 },
                { added: 1, path: "ok.md", removed: 0 },
            ],
            patch: "x".repeat(300 * 1024),
        });

        expect(event.summary?.files).toEqual([{ added: 1, path: "ok.md", removed: 0 }]);
        expect(event.summary?.patch).toEqual({ tooLarge: true });
        expect(turnEndEvent("failed", "boom", { files: [{ added: 1, path: "..", removed: 0 }] })).toEqual({ error: "boom", kind: "turn_end", reason: "failed" });
    });
});

describe("what a turn may hold", () => {
    it("stops reading files once the turn names more than it lists", async () => {
        const locations = await Promise.all(
            Array.from({ length: MAX_SUMMARY_FILES + 50 }, async (_, index) => {
                const file = path.join(work, `f${String(index)}.txt`);

                await writeFile(file, "x\n");

                return { path: file };
            }),
        );
        const changes = recorder();

        changes.note({ id: "1", kind: "edit", status: "pending" }, { kind: "edit", locations, status: "pending", toolCallId: "1" });
        await expect.poll(() => reads.length).toBe(MAX_SUMMARY_FILES);
        await changes.summary();

        expect(reads).toHaveLength(MAX_SUMMARY_FILES);
    });

    it("does not let files it dropped use up the slots", async () => {
        const names = Array.from({ length: 150 }, (_, index) => `bin${String(index)}.dat`);

        await Promise.all(names.map(async (name) => await writeFile(path.join(work, name), Buffer.from([0, 1]))));

        const changes = recorder();

        const locations = names.map((name) => {
            return { path: path.join(work, name) };
        });

        changes.note({ id: "1", kind: "edit", status: "pending" }, { kind: "edit", locations, status: "pending", toolCallId: "1" });
        changes.note({ id: "1", kind: "edit", status: "completed" }, { status: "completed", toolCallId: "1" });
        await expect.poll(() => reads.length).toBe(300);
        // The binary files are let go once the reads are in.
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });

        for (let index = 0; index < 100; index += 1) {
            changes.note({ id: `d${String(index)}`, kind: "edit", status: "completed" }, diffCall(`d${String(index)}`, `new${String(index)}.md`, null, "x\n"));
        }

        const summary = await changes.summary();

        expect(summary?.files).toHaveLength(100);
    });

    it("counts the bytes it is about to read: files past the turn's room are not read", async () => {
        const big = "x".repeat(900 * 1024);
        const locations = await Promise.all(
            Array.from({ length: 24 }, async (_, index) => {
                const file = path.join(work, `big${String(index)}.txt`);

                await writeFile(file, big);

                return { path: file };
            }),
        );
        const changes = recorder();

        changes.note({ id: "1", kind: "edit", status: "pending" }, { kind: "edit", locations, status: "pending", toolCallId: "1" });
        await expect.poll(() => reads.length).toBeGreaterThan(16);
        await new Promise((resolve) => {
            setTimeout(resolve, 100);
        });

        // 900 KiB a file against 16 MiB: the read that crosses the cap is the last.
        expect(reads.length).toBeGreaterThan(16);
        expect(reads.length).toBeLessThanOrEqual(19);
    });

    it("measures a side in UTF-8 bytes: a text under the cap in characters and over it in bytes is left out", async () => {
        const changes = recorder();

        changes.note({ id: "1", kind: "edit", status: "completed" }, diffCall("1", "wide.md", null, "あ".repeat(400_000)));
        changes.note({ id: "2", kind: "edit", status: "completed" }, diffCall("2", "narrow.md", null, "a".repeat(400_000)));

        const summary = await changes.summary();

        expect(summary?.files.map((file) => file.path)).toEqual(["narrow.md"]);
    });
});

describe("a call first seen already complete", () => {
    it("is listed when it carries diff content, and left out when it only names a path", async () => {
        await writeFile(path.join(work, "named.txt"), "already written\n");

        const changes = recorder();

        changes.note({ id: "1", kind: "edit", status: "completed" }, diffCall("1", "diff.md", "a\n", "b\n"));
        changes.note({ id: "2", kind: "edit", status: "completed" }, { kind: "edit", locations: [{ path: path.join(work, "named.txt") }], status: "completed", toolCallId: "2" });

        const summary = await changes.summary();

        expect(summary?.files).toEqual([{ added: 1, path: "diff.md", removed: 1 }]);
    });
});

describe("a delete and a move", () => {
    it("lists a deleted empty file, and a move as a delete of the old path and a create of the new one", async () => {
        await writeFile(path.join(work, "empty.txt"), "");
        await writeFile(path.join(work, "old.txt"), "one\ntwo\n");

        const changes = recorder();
        const empty = path.join(work, "empty.txt");
        const moved = [{ path: path.join(work, "old.txt") }, { path: path.join(work, "new.txt") }];

        changes.note({ id: "1", kind: "delete", status: "pending" }, { kind: "delete", locations: [{ path: empty }], status: "pending", toolCallId: "1" });
        changes.note({ id: "2", kind: "move", status: "pending" }, { kind: "move", locations: moved, status: "pending", toolCallId: "2" });
        await expect.poll(() => reads.length).toBe(2);
        // The path that does not exist yet is checked, not read.
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });
        await unlink(empty);
        await rename(path.join(work, "old.txt"), path.join(work, "new.txt"));
        changes.note({ id: "1", kind: "delete", status: "completed" }, { status: "completed", toolCallId: "1" });
        changes.note({ id: "2", kind: "move", status: "completed" }, { status: "completed", toolCallId: "2" });

        const summary = await changes.summary();

        expect(summary?.files).toEqual([
            { added: 0, path: "empty.txt", removed: 0 },
            { added: 2, path: "new.txt", removed: 0 },
            { added: 0, path: "old.txt", removed: 2 },
        ]);
        expect(summary?.patch).toContain("+++ /dev/null");
        expect(summary?.patch).toContain("--- /dev/null");
    });
});

describe("a diff's limits", () => {
    it("counts a file as removed then added when the turn's table budget is spent, and prints no patch past the byte budget", () => {
        const before = `${Array.from({ length: 50 }, (_, index) => `line ${String(index)}`).join("\n")}\n`;
        const after = before.replace("line 10", "LINE 10");
        const exact = unifiedDiff("a", before, after);
        const spent = unifiedDiff("a", before, after, new DiffLimits(0, 1_000_000));

        expect(exact).toMatchObject({ added: 1, removed: 1 });
        // The common start and end are still trimmed, so the fallback is the changed middle.
        expect(spent.added).toBeGreaterThanOrEqual(1);
        expect(spent.removed).toBeGreaterThanOrEqual(1);

        const limits = newDiffLimits(40);
        const capped = unifiedDiff("a", before, after, limits);

        expect(capped).toMatchObject({ added: 1, overflow: true, patch: "", removed: 1 });
        expect(unifiedDiff("b", before, after, new DiffLimits(1000, 0))).toMatchObject({ overflow: true, patch: "" });
    });

    it("spends the byte budget across files, so a later file past it keeps its counts but not its text", async () => {
        const changes = recorder();
        const lines = (tag: string) => Array.from({ length: 7000 }, (_, index) => `${tag} ${String(index)}`).join("\n");

        changes.note({ id: "1", kind: "edit", status: "completed" }, diffCall("1", "a.ts", null, `${lines("a")}\n`));
        changes.note({ id: "2", kind: "edit", status: "completed" }, diffCall("2", "b.ts", null, `${lines("b")}\n`));

        const summary = await changes.summary();

        expect(summary?.files.map((file) => file.added)).toEqual([7000, 7000]);
        expect(summary?.patch).toEqual({ tooLarge: true });
    });

    it("diffs CRLF text line by line, and sees a whole-file change of line endings", () => {
        const crlf = unifiedDiff("a", "one\r\ntwo\r\n", "one\r\nTWO\r\n");

        expect(crlf).toMatchObject({ added: 1, removed: 1 });
        expect(crlf.patch).toContain("-two\r\n+TWO\r\n");
        expect(unifiedDiff("a", "one\ntwo\n", "one\r\ntwo\r\n")).toMatchObject({ added: 2, removed: 2 });
    });

    it("prints a delete against /dev/null, with or without lines", () => {
        expect(unifiedDiff("gone.txt", "a\nb\n", null)).toEqual({ added: 0, patch: "--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n", removed: 2 });
        expect(unifiedDiff("empty.txt", "", null)).toEqual({ added: 0, patch: "--- a/empty.txt\n+++ /dev/null\n", removed: 0 });
    });
});

describe("the files a call reads", () => {
    it.skipIf(process.platform === "win32")("never follows a link at the last step, and reads only regular files", async () => {
        await writeFile(path.join(work, "real.txt"), "hello\n");
        await symlink(path.join(work, "real.txt"), path.join(work, "link.txt"));
        await mkdir(path.join(work, "folder"));

        await expect(nodeIo.readRegular(path.join(work, "real.txt"), 100)).resolves.toEqual(Buffer.from("hello\n"));
        await expect(nodeIo.readRegular(path.join(work, "link.txt"), 100)).rejects.toThrow();
        await expect(nodeIo.readRegular(path.join(work, "folder"), 100)).resolves.toBeUndefined();
        await expect(nodeIo.readRegular(path.join(work, "real.txt"), 3)).resolves.toBeUndefined();
    });

    it("reads inside the folder and refuses a folder-escaping link even when only the last step is a link", async () => {
        await writeFile(path.join(temporary, "outside.txt"), "outside\n");
        await symlink(path.join(temporary, "outside.txt"), path.join(work, "escape.txt"));

        const files = new FolderFiles(work, io());

        await expect(files.read("escape.txt")).resolves.toBeUndefined();
        expect(reads).toEqual([]);
    });
});

describe("a folder the core canonicalised on Windows", () => {
    it(String.raw`loses the verbatim prefix, so it compares with the C:\ paths an agent names`, () => {
        expect(withoutVerbatimPrefix(String.raw`\\?\C:\Users\me\work`)).toBe(String.raw`C:\Users\me\work`);
        expect(withoutVerbatimPrefix(String.raw`\\?\UNC\server\share\work`)).toBe(String.raw`\\server\share\work`);
        expect(withoutVerbatimPrefix(String.raw`C:\Users\me`)).toBe(String.raw`C:\Users\me`);
        expect(withoutVerbatimPrefix("/home/me/work")).toBe("/home/me/work");
        expect(withoutVerbatimPrefix(String.raw`\\?\Volume{1}\x`)).toBe(String.raw`\\?\Volume{1}\x`);
    });
});
