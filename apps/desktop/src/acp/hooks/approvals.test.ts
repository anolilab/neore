import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
        new HookApprovals(file).approve("claude", "/work/a", "hash-1");

        const reopened = new HookApprovals(file);

        expect(reopened.get("claude", "/work/a")).toBe("hash-1");
        expect(reopened.get("claude", "/work/b")).toBeUndefined();
    });

    it("replaces the hash when the file is approved again, and forgets on revoke", () => {
        const approvals = new HookApprovals(file);

        approvals.approve("claude", "/work/a", "hash-1");
        approvals.approve("claude", "/work/a", "hash-2");
        expect(approvals.get("claude", "/work/a")).toBe("hash-2");
        approvals.revoke("claude", "/work/a");
        expect(new HookApprovals(file).get("claude", "/work/a")).toBeUndefined();
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps an approval it could not forget on disk, so a retry saves the revoke", () => {
        const approvals = new HookApprovals(file);

        approvals.approve("claude", "/work/a", "hash-1");
        chmodSync(directory, 0o500);

        try {
            expect(() => {
                approvals.revoke("claude", "/work/a");
            }).toThrow();
            expect(approvals.get("claude", "/work/a")).toBe("hash-1");
        } finally {
            chmodSync(directory, 0o700);
        }

        approvals.revoke("claude", "/work/a");
        expect(new HookApprovals(file).get("claude", "/work/a")).toBeUndefined();
    });

    it("is private to the user", () => {
        new HookApprovals(file).approve("claude", "/work/a", "hash-1");
        expect((statSync(file).mode % 0o100).toString(8)).toBe("0");
    });

    it("starts empty, approving nothing, when the file is damaged", () => {
        writeFileSync(file, "{ nope");
        expect(new HookApprovals(file).get("claude", "/work/a")).toBeUndefined();
        writeFileSync(file, JSON.stringify({ approvals: { [JSON.stringify(["claude", "/work/a"])]: 5 }, version: 2 }));
        expect(new HookApprovals(file).get("claude", "/work/a")).toBeUndefined();
    });

    it("keeps a bounded number of folders", () => {
        const approvals = new HookApprovals(file);

        for (let index = 0; index < 250; index += 1) {
            approvals.approve("claude", `/work/${String(index)}`, "h");
        }

        const saved = JSON.parse(readFileSync(file, "utf8")) as { approvals: object };

        expect(Object.keys(saved.approvals).length).toBeLessThanOrEqual(200);
        expect(approvals.get("claude", "/work/249")).toBe("h");
    });

    it("binds an approval to one agent in one folder", () => {
        const approvals = new HookApprovals(file);

        approvals.approve("claude", "/work/a", "hash-1");

        expect(approvals.get("claude", "/work/a")).toBe("hash-1");
        expect(approvals.get("codex", "/work/a")).toBeUndefined();
        expect(approvals.get("claude", "/work/b")).toBeUndefined();

        approvals.approve("codex", "/work/a", "hash-2");
        approvals.revoke("claude", "/work/a");
        expect(approvals.get("codex", "/work/a")).toBe("hash-2");
        expect(new HookApprovals(file).get("claude", "/work/a")).toBeUndefined();
    });

    it("cannot confuse an agent and a folder whose names run together", () => {
        const approvals = new HookApprovals(file);

        approvals.approve("a", "b/c", "hash-1");

        expect(approvals.get("a/b", "c")).toBeUndefined();
        expect(approvals.get("a\u{0}b", "c")).toBeUndefined();
    });

    it("reads an approval made for a folder alone, before agents were part of it, as nothing approved", () => {
        writeFileSync(file, JSON.stringify({ approvals: { "/work/a": "hash-1" }, version: 1 }));

        expect(new HookApprovals(file).get("claude", "/work/a")).toBeUndefined();
        expect(new HookApprovals(file).get("/work/a", "")).toBeUndefined();
    });
});
