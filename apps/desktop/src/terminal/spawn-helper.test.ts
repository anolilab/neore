import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { makeSpawnHelperExecutable } from "./spawn-helper";

const modeOf = (file: string): number => statSync(file).mode % 0o1000;

describe("makeSpawnHelperExecutable", () => {
    it("adds the execute bit the tarball leaves out, for this platform's prebuild only", () => {
        const root = mkdtempSync(path.join(tmpdir(), "neore-pty-"));
        const mine = path.join(root, "prebuilds", "darwin-arm64", "spawn-helper");
        const other = path.join(root, "prebuilds", "darwin-x64", "spawn-helper");

        for (const file of [mine, other]) {
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, "binary");
            chmodSync(file, 0o644);
        }

        makeSpawnHelperExecutable(root, "darwin", "arm64");

        expect(modeOf(mine)).toBe(0o755);
        expect(modeOf(other)).toBe(0o644);
    });

    it("does not touch a packaged app, whose signature a changed file would break", () => {
        const root = mkdtempSync(path.join(tmpdir(), "neore-pty-"));
        const packaged = path.join(root, "app.asar.unpacked", "node_modules", "node-pty");
        const helper = path.join(packaged, "prebuilds", "darwin-arm64", "spawn-helper");

        mkdirSync(path.dirname(helper), { recursive: true });
        writeFileSync(helper, "binary");
        chmodSync(helper, 0o644);

        makeSpawnHelperExecutable(path.join(root, "app.asar", "node_modules", "node-pty"), "darwin", "arm64");
        makeSpawnHelperExecutable(packaged, "darwin", "arm64");

        expect(modeOf(helper)).toBe(0o644);
    });

    it("leaves an executable file alone and tolerates a missing one", () => {
        const root = mkdtempSync(path.join(tmpdir(), "neore-pty-"));
        const built = path.join(root, "build", "Release", "spawn-helper");

        mkdirSync(path.dirname(built), { recursive: true });
        writeFileSync(built, "binary");
        chmodSync(built, 0o700);

        expect(() => makeSpawnHelperExecutable(root, "linux", "x64")).not.toThrow();
        expect(modeOf(built)).toBe(0o700);
    });
});
