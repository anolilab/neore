import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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

    it("caps the held files in count, keeping the earliest", () => {
        const drop = Array.from({ length: 25 }, (_, index) => {
            return { data: new Uint8Array([index]), name: `${index}.txt` };
        });

        const held = queueDroppedFiles(undefined, drop);

        expect(held).toHaveLength(20);
        expect(held.at(-1)?.name).toBe("19.txt");
    });

    it("caps the held files in bytes: the first file that does not fit ends the drop", () => {
        const big = { data: new Uint8Array(60 * 1024 * 1024), name: "big.bin" };
        const small = { data: new Uint8Array(1), name: "small.txt" };

        const held = queueDroppedFiles([big], [big, small]);

        expect(held.map((file) => file.name)).toEqual(["big.bin"]);
    });
});

describe("readDroppedFiles", () => {
    it("refuses a symbolic link, so a dropped link cannot attach the file it points at", async () => {
        const folder = await mkdtemp(path.join(tmpdir(), "neore-drop-"));
        const secret = path.join(folder, "secret.txt");
        const link = path.join(folder, "link.txt");

        await writeFile(secret, "private");
        await symlink(secret, link);

        expect(await readDroppedFiles([link])).toStrictEqual([]);
    });

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
