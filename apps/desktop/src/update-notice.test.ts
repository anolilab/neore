import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    clearPendingUpdate,
    compareVersions,
    decideUpdateOutcome,
    parsePendingUpdate,
    PENDING_UPDATE_FILE,
    readPendingUpdate,
    writePendingUpdate,
} from "./update-notice.js";

describe("compareVersions", () => {
    it("orders by major, minor and patch", () => {
        expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
        expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
        expect(compareVersions("v2.0.0", "2.0.0")).toBe(0);
        expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(0);
    });

    it("says nothing for a string that is not a version", () => {
        expect(compareVersions("nightly", "1.0.0")).toBeUndefined();
    });
});

describe("decideUpdateOutcome", () => {
    it("has nothing to say without a downloaded update", () => {
        expect(decideUpdateOutcome(undefined, "1.0.0")).toStrictEqual({ kind: "none" });
    });

    it("forgets an update that is now the running version", () => {
        expect(decideUpdateOutcome({ version: "1.1.0" }, "1.1.0")).toStrictEqual({ kind: "applied" });
        expect(decideUpdateOutcome({ version: "1.1.0" }, "1.2.0")).toStrictEqual({ kind: "applied" });
    });

    it("tells the person once when the restarted app is still on the old version", () => {
        expect(decideUpdateOutcome({ version: "1.1.0" }, "1.0.0")).toStrictEqual({ current: "1.0.0", kind: "not-applied", version: "1.1.0" });
        expect(decideUpdateOutcome({ noticed: true, version: "1.1.0" }, "1.0.0")).toStrictEqual({ kind: "still-pending" });
    });
});

describe("the pending update file", () => {
    let temporaryDirectory: string;

    beforeEach(() => {
        temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "neore-update-"));
    });

    afterEach(() => {
        rmSync(temporaryDirectory, { force: true, recursive: true });
    });

    it("round-trips and clears", () => {
        const file = path.join(temporaryDirectory, PENDING_UPDATE_FILE);

        expect(readPendingUpdate(file)).toBeUndefined();
        writePendingUpdate(file, { version: "1.1.0" });
        expect(readPendingUpdate(file)).toStrictEqual({ version: "1.1.0" });
        writePendingUpdate(file, { noticed: true, version: "1.1.0" });
        expect(readPendingUpdate(file)).toStrictEqual({ noticed: true, version: "1.1.0" });
        clearPendingUpdate(file);
        expect(readPendingUpdate(file)).toBeUndefined();
    });

    it("ignores a file that is not a version record", () => {
        expect(parsePendingUpdate("not json")).toBeUndefined();
        expect(parsePendingUpdate("{\"version\":\"latest\"}")).toBeUndefined();
        expect(parsePendingUpdate("{\"version\":1}")).toBeUndefined();
    });
});
