import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findNodeTools } from "./node-tools";

const present = (...files: string[]) => (file: string) => files.includes(file);

describe("findNodeTools", () => {
    it("returns absolute paths from the first folder that holds both programs", () => {
        const isFile = present("/a/node", "/b/node", "/b/npm");

        expect(findNodeTools("/a:/b", isFile)).toEqual({ node: "/b/node", npm: "/b/npm" });
    });

    it("ignores a relative PATH entry, so a program in the working folder is never picked", () => {
        expect(findNodeTools(".:bin", present("./node", "./npm", "bin/node", "bin/npm"))).toBeUndefined();
    });

    it("also looks in the folders a GUI app's short PATH leaves out", () => {
        expect(findNodeTools("/usr/bin", present("/opt/homebrew/bin/node", "/opt/homebrew/bin/npm"))).toEqual({ node: "/opt/homebrew/bin/node", npm: "/opt/homebrew/bin/npm" });
    });

    it("finds nothing when either program is missing", () => {
        expect(findNodeTools("/a", present("/a/node"))).toBeUndefined();
        expect(findNodeTools(undefined, present())).toBeUndefined();
    });
});

describe("findNodeTools with the real file check", () => {
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
