/** The hooks file against the real file system: a link is never followed, and the hash is of the bytes that were parsed. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HOOKS_PATH, loadHooksFile } from "./file";
import { nodeHookFs } from "./fs";
import { MAX_FILE_BYTES } from "./schema";

const content = JSON.stringify({ hooks: [{ id: "m", name: "M", on: "manual", prompt: "Hello." }], version: 1 });

let directory: string;
let root: string;
let outside: string;

beforeEach(() => {
    // The runner hands over the folder's real path (/var is a link on macOS).
    const prefix = path.join(tmpdir(), "neore-hooks-file-");

    directory = realpathSync(mkdtempSync(prefix));
    root = path.join(directory, "project");
    outside = path.join(directory, "outside");
    mkdirSync(path.join(root, ".neore"), { recursive: true });
    mkdirSync(path.join(outside, ".neore"), { recursive: true });
    writeFileSync(path.join(outside, "secret.json"), content);
    writeFileSync(path.join(outside, ".neore", "hooks.json"), content);
});

afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
});

describe("loadHooksFile", () => {
    it("reads a regular file and hashes the bytes it parsed", async () => {
        writeFileSync(path.join(root, HOOKS_PATH), content);

        const file = await loadHooksFile(nodeHookFs, root);

        expect(file).toMatchObject({ hash: createHash("sha256").update(content).digest("hex"), state: "ok" });
    });

    it("says none for a missing file or folder", async () => {
        expect(await loadHooksFile(nodeHookFs, root)).toEqual({ state: "none" });
        rmSync(path.join(root, ".neore"), { recursive: true });
        expect(await loadHooksFile(nodeHookFs, root)).toEqual({ state: "none" });
    });

    it("refuses a hooks file that is a link", async () => {
        symlinkSync(path.join(outside, "secret.json"), path.join(root, HOOKS_PATH));

        expect(await loadHooksFile(nodeHookFs, root)).toMatchObject({ state: "invalid" });
    });

    it("refuses a .neore folder that is a link", async () => {
        rmSync(path.join(root, ".neore"), { recursive: true });
        symlinkSync(path.join(outside, ".neore"), path.join(root, ".neore"));

        expect(await loadHooksFile(nodeHookFs, root)).toMatchObject({ state: "invalid" });
    });

    it("refuses a file larger than the cap without parsing it", async () => {
        writeFileSync(path.join(root, HOOKS_PATH), " ".repeat(MAX_FILE_BYTES + 10));

        expect(await loadHooksFile(nodeHookFs, root)).toMatchObject({ state: "invalid" });
    });
});

describe("nodeHookFs.readInside", () => {
    it("refuses a link itself, even when no earlier check ran", async () => {
        symlinkSync(path.join(outside, "secret.json"), path.join(root, HOOKS_PATH));

        expect(await nodeHookFs.readInside(root, HOOKS_PATH, 1000)).toMatchObject({ state: "refused" });
    });

    it("refuses a path through a linked folder", async () => {
        rmSync(path.join(root, ".neore"), { recursive: true });
        symlinkSync(path.join(outside, ".neore"), path.join(root, ".neore"));

        expect(await nodeHookFs.readInside(root, HOOKS_PATH, 1000)).toMatchObject({ state: "refused" });
    });

    it("refuses a root that resolves somewhere else than the one asked about", async () => {
        const alias = path.join(directory, "alias");

        writeFileSync(path.join(root, HOOKS_PATH), content);
        symlinkSync(root, alias);

        expect(await nodeHookFs.readInside(alias, HOOKS_PATH, 1000)).toMatchObject({ state: "refused" });
    });

    it("refuses what is not a regular file", async () => {
        mkdirSync(path.join(root, HOOKS_PATH));

        expect(await nodeHookFs.readInside(root, HOOKS_PATH, 1000)).toMatchObject({ state: "refused" });
    });
});
