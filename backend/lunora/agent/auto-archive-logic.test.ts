import { describe, expect, it } from "vitest";

import { type AutoArchiveCandidate, autoArchiveCutoff, isAutoArchiveDays, selectAutoArchiveDue } from "./auto-archive-logic";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1000 * DAY;
const CUTOFF = autoArchiveCutoff(NOW, 30);
const old = (overrides: Partial<AutoArchiveCandidate> & { _id: string }): AutoArchiveCandidate => {
    return {
        status: "active",
        updatedAt: CUTOFF - DAY,
        ...overrides,
    };
};
const none = { liveThreadIds: new Set<string>(), pinnedProjectIds: new Set<string>() };

describe("isAutoArchiveDays", () => {
    it.each([0, 7, 30, 90, 180, 365])("allows %i", (days) => {
        expect(isAutoArchiveDays(days)).toBe(true);
    });

    it.each([undefined, 1, 6, 366, 7.5, -7])("refuses %s", (days) => {
        expect(isAutoArchiveDays(days)).toBe(false);
    });
});

describe("selectAutoArchiveDue", () => {
    it("selects an idle active thread", () => {
        expect(selectAutoArchiveDue([old({ _id: "a" })], CUTOFF, none, 100)).toStrictEqual(["a"]);
    });

    it("skips a thread that was active inside the window", () => {
        expect(selectAutoArchiveDue([old({ _id: "a", updatedAt: CUTOFF + 1 })], CUTOFF, none, 100)).toStrictEqual([]);
    });

    it.each([
        ["already archived", { status: "archived" }],
        ["running", { status: "running" }],
        ["deleted", { deleted: true }],
        ["temporary", { isTemporary: true }],
        ["pinned", { pinnedAt: 5 }],
        ["in a pinned project", { projectId: "p1" }],
        ["without updatedAt", { updatedAt: undefined }],
    ])("never archives a %s thread", (_label, overrides) => {
        expect(selectAutoArchiveDue([old({ _id: "a", ...overrides })], CUTOFF, { ...none, pinnedProjectIds: new Set(["p1"]) }, 100)).toStrictEqual([]);
    });

    it("never archives a thread with a live stream", () => {
        expect(selectAutoArchiveDue([old({ _id: "a" })], CUTOFF, { ...none, liveThreadIds: new Set(["a"]) }, 100)).toStrictEqual([]);
    });

    it("keeps threads in a project that is not pinned", () => {
        expect(selectAutoArchiveDue([old({ _id: "a", projectId: "p2" })], CUTOFF, { ...none, pinnedProjectIds: new Set(["p1"]) }, 100)).toStrictEqual(["a"]);
    });

    it("keeps the input order and caps the batch", () => {
        const rows = [old({ _id: "c", updatedAt: CUTOFF - 3 * DAY }), old({ _id: "b", updatedAt: CUTOFF - 2 * DAY }), old({ _id: "a" })];

        expect(selectAutoArchiveDue(rows, CUTOFF, none, 2)).toStrictEqual(["c", "b"]);
    });
});
