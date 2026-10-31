import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HookApprovals } from "./approvals";

let directory: string;
let file: string;

beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "neore-hook-approvals-"));
    file = path.join(directory, "approvals.json");
});

afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
});

describe("HookApprovals", () => {
    it("remembers an approval across restarts, bound to the folder and the hash", () => {
        new HookApprovals(file).approve("/work/a", "hash-1");

        const reopened = new HookApprovals(file);

        expect(reopened.get("/work/a")).toBe("hash-1");
        expect(reopened.get("/work/b")).toBeUndefined();
    });

    it("replaces the hash when the file is approved again, and forgets on revoke", () => {
        const approvals = new HookApprovals(file);

        approvals.approve("/work/a", "hash-1");
        approvals.approve("/work/a", "hash-2");
        expect(approvals.get("/work/a")).toBe("hash-2");
        approvals.revoke("/work/a");
        expect(new HookApprovals(file).get("/work/a")).toBeUndefined();
    });

    it("is private to the user", () => {
        new HookApprovals(file).approve("/work/a", "hash-1");
        expect((statSync(file).mode % 0o100).toString(8)).toBe("0");
    });

    it("starts empty, approving nothing, when the file is damaged", () => {
        writeFileSync(file, "{ nope");
        expect(new HookApprovals(file).get("/work/a")).toBeUndefined();
        writeFileSync(file, JSON.stringify({ approvals: { "/work/a": 5 }, version: 1 }));
        expect(new HookApprovals(file).get("/work/a")).toBeUndefined();
    });

    it("keeps a bounded number of folders", () => {
        const approvals = new HookApprovals(file);

        for (let index = 0; index < 250; index += 1) {
            approvals.approve(`/work/${String(index)}`, "h");
        }

        const saved = JSON.parse(readFileSync(file, "utf8")) as { approvals: object };

        expect(Object.keys(saved.approvals).length).toBeLessThanOrEqual(200);
        expect(approvals.get("/work/249")).toBe("h");
    });
});
