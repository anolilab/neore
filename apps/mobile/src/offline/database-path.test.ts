import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { databaseDirectory } from "./database-path";

const OPEN_CALL = /openDatabaseAsync\(DATABASE_NAME, undefined, databaseDirectory\(Paths\.cache\.uri\)\)/;

describe("databaseDirectory", () => {
    it("turns the cache directory URI into a path without a trailing slash", () => {
        expect(databaseDirectory("file:///var/mobile/Containers/Data/Application/ABC/Library/Caches/")).toBe("/var/mobile/Containers/Data/Application/ABC/Library/Caches");
        expect(databaseDirectory("file:///data/user/0/ai.neore.mobile/cache/")).toBe("/data/user/0/ai.neore.mobile/cache");
    });

    it("decodes an escaped path", () => {
        expect(databaseDirectory("file:///data/My%20App/cache/")).toBe("/data/My App/cache");
    });
});

describe("the cache file's location", () => {
    it("is opened in the cache directory, never in the default folder that is backed up", () => {
        const source = readFileSync(join(import.meta.dirname, "database.ts"), "utf8");

        expect(source).toMatch(OPEN_CALL);
    });
});
