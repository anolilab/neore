import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findNodeTools, resolveNodeTools } from "./node-tools";

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

describe(resolveNodeTools, () => {
    const bin = absolute("home", "me", ".volta", "tools", "image", "node", "22.1.0", "bin");
    const real = { node: path.join(bin, "node"), npm: path.join(bin, "npm") };
    const shim = { node: absolute("home", "me", ".volta", "bin", "node"), npm: absolute("home", "me", ".volta", "bin", "npm") };
    const files = new Set([real.node, real.npm]);
    const answers = (npmVersion: string) => async (program: string, args: string[]): Promise<string> => {
        if (program === shim.node && args.join(" ") === "-p process.execPath") {
            return `${real.node}\n`;
        }

        if (program === real.node && args[1] === "--version") {
            return `${npmVersion}\n`;
        }

        throw new Error(`unexpected run: ${program} ${args.join(" ")}`);
    };

    it("uses the binary a shim runs and the npm next to it", async () => {
        await expect(resolveNodeTools(shim, answers("11.10.0"), (file) => files.has(file))).resolves.toStrictEqual(real);
    });

    it("refuses an npm older than 11.10", async () => {
        await expect(resolveNodeTools(shim, answers("11.9.3"), (file) => files.has(file))).rejects.toThrow("older than 11.10");
        await expect(resolveNodeTools(shim, answers("10.9.2"), (file) => files.has(file))).rejects.toThrow("older than 11.10");
    });

    it("refuses an npm whose version it cannot read", async () => {
        for (const version of ["", "npm", "eleven", "11"]) {
            // eslint-disable-next-line no-await-in-loop -- one case at a time
            await expect(resolveNodeTools(shim, answers(version), (file) => files.has(file))).rejects.toThrow("older than 11.10");
        }
    });

    it("refuses a node that names no binary, and one with no npm beside it", async () => {
        const relative = async (): Promise<string> => "node\n";

        await expect(resolveNodeTools(shim, relative, () => true)).rejects.toThrow("did not name the Node.js binary");
        await expect(resolveNodeTools(shim, answers("11.10.0"), (file) => file === real.node)).rejects.toThrow("npm was not found next to Node.js");
    });

    it("says so when the node it found does not run", async () => {
        const broken = async (): Promise<string> => {
            throw new Error("spawn EACCES");
        };

        await expect(resolveNodeTools(shim, broken, () => true)).rejects.toThrow("did not run");
    });
});
