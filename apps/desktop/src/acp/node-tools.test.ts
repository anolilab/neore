import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findNodeTools } from "./node-tools";

const present = (...files: string[]) => (file: string) => files.includes(file);
/** Absolute on any host: the drive or `/` the tests run from. */
const { root } = path.parse(process.cwd());
const absolute = (...parts: string[]): string => path.join(root, ...parts);
const searchPath = (...directories: string[]): string => directories.join(path.delimiter);

describe("findNodeTools", () => {
    it("returns absolute paths from the first folder that holds both programs", () => {
        const [a, b] = [absolute("a"), absolute("b")];
        const isFile = present(path.join(a, "node"), path.join(b, "node"), path.join(b, "npm"));

        expect(findNodeTools(searchPath(a, b), isFile)).toEqual({ node: path.join(b, "node"), npm: path.join(b, "npm") });
    });

    it("ignores a relative PATH entry, so a program in the working folder is never picked", () => {
        const files = [".", "bin"].flatMap((folder) => [path.join(folder, "node"), path.join(folder, "npm")]);

        expect(findNodeTools(searchPath(".", "bin"), present(...files))).toBeUndefined();
    });

    it("also looks in the folders a GUI app's short PATH leaves out", () => {
        const homebrew = absolute("opt", "homebrew", "bin");
        const files = [path.join(homebrew, "node"), path.join(homebrew, "npm")];
        const both = present(...files);
        const found = findNodeTools(absolute("usr", "bin"), both);

        expect(found).toEqual({ node: path.join(homebrew, "node"), npm: path.join(homebrew, "npm") });
    });

    it("finds nothing when either program is missing", () => {
        const a = absolute("a");

        const onlyNode = present(path.join(a, "node"));

        expect(findNodeTools(a, onlyNode)).toBeUndefined();
        expect(findNodeTools(undefined, present())).toBeUndefined();
    });
});

// Execute bits are a POSIX notion; on Windows the check has nothing to tell apart.
describe.skipIf(process.platform === "win32")("findNodeTools with the real file check", () => {
    const folders: string[] = [];
    const folder = (): string => {
        const made = mkdtempSync(path.join(tmpdir(), "neore-node-tools-"));

        folders.push(made);

        return made;
    };
    const program = (directory: string, name: string, mode: number) => {
        writeFileSync(path.join(directory, name), "#!/bin/sh\n");
        chmodSync(path.join(directory, name), mode);
    };

    afterEach(() => {
        for (const made of folders) {
            rmSync(made, { force: true, recursive: true });
        }

        folders.length = 0;
    });

    it("takes executable files, and skips a file without the execute bit or a folder named like the program", () => {
        const ready = folder();
        const unready = folder();
        const lookalike = folder();

        program(ready, "node", 0o755);
        program(ready, "npm", 0o755);
        program(unready, "node", 0o644);
        program(unready, "npm", 0o644);
        mkdirSync(path.join(lookalike, "node"));
        mkdirSync(path.join(lookalike, "npm"));

        const found = findNodeTools([lookalike, unready, ready].join(path.delimiter));

        expect(found).toEqual({ node: path.join(ready, "node"), npm: path.join(ready, "npm") });
        expect(findNodeTools([lookalike, unready].join(path.delimiter))?.node ?? "").not.toContain(unready);
    });
});
