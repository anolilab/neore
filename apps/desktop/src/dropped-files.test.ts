import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { queueDroppedFiles, readDroppedFiles } from "./dropped-files.js";

describe("queueDroppedFiles", () => {
    it("keeps files from earlier drops until the page takes them, in arrival order", () => {
        const first = [{ data: new Uint8Array([1]), name: "a.txt" }];
        const second = [{ data: new Uint8Array([2]), name: "b.txt" }];

        const held = queueDroppedFiles(undefined, first);

        expect(queueDroppedFiles(held, second).map((file) => file.name)).toEqual(["a.txt", "b.txt"]);
    });
});

describe("readDroppedFiles", () => {
    it("reads regular files and skips directories, relative paths, missing files and oversize files", async () => {
        const folder = await mkdtemp(path.join(tmpdir(), "neore-drop-"));
        const small = path.join(folder, "note.txt");
        const big = path.join(folder, "big.bin");

        await writeFile(small, "hi");
        await writeFile(big, "0123456789");
        await mkdir(path.join(folder, "folder"));

        const files = await readDroppedFiles([small, path.join(folder, "folder"), "relative.txt", path.join(folder, "missing"), big], 5);

        expect(files.map((file) => file.name)).toEqual(["note.txt"]);
        expect(Buffer.from(files[0].data).toString()).toBe("hi");
    });
});
