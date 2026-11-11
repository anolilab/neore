import { describe, expect, it } from "vitest";

import {
    actionsFor,
    canonicalJson,
    compareVersions,
    contentHash,
    diffUpdate,
    isCompletePluginExport,
    isDowngrade,
    LEASE_MS,
    leaseExpired,
    markerFor,
    parseMarker,
    shardWriteAllowed,
} from "./logic";

describe("actionsFor (the status table)", () => {
    it.each([
        ["installed", false, ["update", "uninstall"]],
        ["installed", true, ["update", "uninstall"]],
        ["needs-repair", false, ["repair", "uninstall"]],
        ["needs-repair", true, ["repair", "uninstall"]],
        ["installing", false, []],
        ["installing", true, ["repair", "uninstall"]],
        ["updating", false, []],
        ["updating", true, ["repair"]],
        ["uninstalling", false, []],
        ["uninstalling", true, ["repair", "uninstall"]],
    ] as const)("%s with lease expired=%s allows %j", (status, expired, allowed) => {
        expect(actionsFor(status, expired)).toEqual(allowed);
    });

    it("never lets an update finish an update that is already half done", () => {
        expect(actionsFor("updating", true)).not.toContain("update");
    });
});

describe("leases and sharded writes", () => {
    it("expires at the lease end, not before", () => {
        const now = 1_000_000;

        expect(leaseExpired(now + LEASE_MS, now)).toBe(false);
        expect(leaseExpired(now, now)).toBe(true);
    });

    it("refuses a sharded write from a stale generation, and one with under 60 seconds of lease left", () => {
        const now = 1_000_000;
        const current = { generation: 3, leaseUntil: now + 120_000 };

        expect(shardWriteAllowed({ generation: 3 }, current, now)).toBe(true);
        expect(shardWriteAllowed({ generation: 2 }, current, now)).toBe(false);
        expect(shardWriteAllowed({ generation: 3 }, { ...current, leaseUntil: now + 59_000 }, now)).toBe(false);
    });
});

describe("markers", () => {
    it("round-trips an install id and an entry key, even when the key contains a colon", () => {
        const marker = markerFor("install-1", "trigger:daily:9");

        expect(parseMarker(marker)).toEqual({ entryKey: "trigger:daily:9", installId: "install-1" });
    });

    it("rejects a marker with no install id or no entry key", () => {
        expect(parseMarker("no-separator")).toBeNull();
        expect(parseMarker(":entry")).toBeNull();
        expect(parseMarker("install:")).toBeNull();
    });
});

describe("contentHash", () => {
    const skill = { instructions: "Summarise the note.", name: "Summary", tags: ["notes"] };

    it("is the same for the same content, whatever the key order", async () => {
        const reordered = { tags: ["notes"], name: "Summary", instructions: "Summarise the note." };

        expect(await contentHash(skill)).toBe(await contentHash(reordered));
    });

    it("changes when the instruction, the name or a schedule changes", async () => {
        const base = await contentHash(skill);

        expect(await contentHash({ ...skill, instructions: "Summarise the note in one line." })).not.toBe(base);
        expect(await contentHash({ ...skill, name: "Summary v2" })).not.toBe(base);
        expect(await contentHash({ ...skill, schedule: "0 9 * * *" })).not.toBe(base);
    });

    it("ignores undefined fields, so an absent field and an undefined one hash the same", () => {
        expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    });
});

describe("diffUpdate", () => {
    type Kind = "group" | "skill" | "trigger";

    const child = (entryKey: string, extra: { currentHash?: string; kind?: Kind; pendingHash?: string } = {}) => ({
        contentHash: "h1",
        currentHash: "h1",
        entryKey,
        kind: "skill" as Kind,
        ...extra,
    });

    const incoming = (entryKey: string, hash: string, kind: Kind = "skill") => ({
        contentHash: hash,
        entryKey,
        kind,
    });

    it("updates an unedited child in place when its content changed", () => {
        expect(diffUpdate([child("a")], [incoming("a", "h2")])).toEqual([{ action: "update", entryKey: "a" }]);
    });

    it("keeps an edited child and reports it, even when the new version changed it", () => {
        expect(diffUpdate([child("a", { currentHash: "edited" })], [incoming("a", "h2")])).toEqual([{ action: "keep-edited", entryKey: "a" }]);
    });

    it("leaves an unchanged child alone", () => {
        expect(diffUpdate([child("a")], [incoming("a", "h1")])).toEqual([{ action: "same", entryKey: "a" }]);
    });

    it("reports a group whose definition changed, and does not change it", () => {
        expect(diffUpdate([child("g", { kind: "group" })], [incoming("g", "h2", "group")])).toEqual([{ action: "report-group", entryKey: "g" }]);
    });

    it("reports a removed group rather than deleting it, since it may have messages", () => {
        expect(diffUpdate([child("g", { kind: "group" })], [])).toEqual([{ action: "report-group", entryKey: "g" }]);
    });

    it("creates a new entry, deletes an unedited removed one, and detaches an edited removed one", () => {
        expect(diffUpdate([child("gone"), child("edited-gone", { currentHash: "edited" })], [incoming("new", "h1")])).toEqual([
            { action: "create", entryKey: "new" },
            { action: "delete", entryKey: "gone" },
            { action: "detach", entryKey: "edited-gone" },
        ]);
    });

    it("replaces a child whose kind changed under the same entry key, rather than writing new content into the old row", () => {
        expect(diffUpdate([child("daily")], [incoming("daily", "h2", "trigger")])).toEqual([
            { action: "delete", entryKey: "daily" },
            { action: "create", entryKey: "daily" },
        ]);
    });

    it("does not treat a child caught mid-update as edited, so the update finishes it rather than keeping it", () => {
        expect(diffUpdate([child("a", { currentHash: "h2", pendingHash: "h2" })], [incoming("a", "h2")])).toEqual([{ action: "update", entryKey: "a" }]);
    });
});

describe("version order and downgrades", () => {
    it("orders major, minor and patch numerically, not as text", () => {
        expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
        expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    });

    it("flags a move to an older version as a downgrade", () => {
        expect(isDowngrade("2.0.0", "1.9.9")).toBe(true);
        expect(isDowngrade("1.0.0", "1.0.1")).toBe(false);
    });

    it.each(["v2.0.0", "1.0", "1.0.0.1", "2.0.0-rc.1", "1.x.0"])("refuses a malformed version %j rather than comparing it", (version) => {
        expect(() => compareVersions(version, "1.0.0")).toThrow("not a major.minor.patch version");
        expect(() => isDowngrade("2.0.0", version)).toThrow("not a major.minor.patch version");
    });
});

describe("isCompletePluginExport", () => {
    const created = (id: string) => ({ contentHash: "h1", currentHash: "h1", id, state: "created" as const });

    const children = [created("s1"), created("t1")];

    it("exports as a plugin only when the selection is exactly the children, all unedited, of an installed plugin", () => {
        expect(isCompletePluginExport({ status: "installed" }, children, new Set(["s1", "t1"]))).toBe(true);
    });

    it("exports as a plain bundle for a partial or mixed selection", () => {
        expect(isCompletePluginExport({ status: "installed" }, children, new Set(["s1"]))).toBe(false);
        expect(isCompletePluginExport({ status: "installed" }, children, new Set(["s1", "t1", "other"]))).toBe(false);
    });

    it("refuses an install that is not installed", () => {
        expect(isCompletePluginExport({ status: "updating" }, children, new Set(["s1", "t1"]))).toBe(false);
    });

    it("refuses a child that is detached, pending, or edited since install", () => {
        const selected = new Set(["s1", "t1"]);

        const other = created("t1");

        expect(isCompletePluginExport({ status: "installed" }, [{ ...created("s1"), state: "detached" }, other], selected)).toBe(false);
        expect(isCompletePluginExport({ status: "installed" }, [{ ...created("s1"), pendingHash: "h2" }, other], selected)).toBe(false);
        expect(isCompletePluginExport({ status: "installed" }, [{ ...created("s1"), currentHash: "edited" }, other], selected)).toBe(false);
    });
});
