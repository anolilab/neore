import { describe, expect, it } from "vitest";

import { type AutoArchiveCandidate, autoArchiveCutoff, isAutoArchiveDays, runArchivePass, selectAutoArchiveDue } from "./auto-archive-logic";

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

/** Rows in the order the index returns them (newest first), paged like the real query. */
const pagedSource = (rows: ReadonlyArray<AutoArchiveCandidate>, pageSize: number) => {
    const fetchPage = async (cursor: string | null) => {
        const start = cursor === null ? 0 : Number(cursor);
        const end = Math.min(start + pageSize, rows.length);

        return { continueCursor: String(end), isDone: end >= rows.length, page: rows.slice(start, end) };
    };

    return fetchPage;
};

const isDueSnapshot = (candidate: AutoArchiveCandidate) => selectAutoArchiveDue([candidate], CUTOFF, none, 1).length === 1;

describe("runArchivePass", () => {
    it("reaches an eligible older thread behind 600 ineligible newer ones", async () => {
        const newerPinned = Array.from({ length: 600 }, (_, index) => old({ _id: `pinned-${index}`, pinnedAt: 1, updatedAt: CUTOFF - 1 - index }));
        const eligible = old({ _id: "eligible", updatedAt: CUTOFF - 1_000_000 });
        const archived: string[] = [];

        const result = await runArchivePass({
            archiveBatch: 100,
            archiveIfStillDue: async (threadId) => {
                archived.push(threadId);

                return true;
            },
            cursor: null,
            fetchPage: pagedSource([...newerPinned, eligible], 200),
            isDue: isDueSnapshot,
            readBudget: 1000,
        });

        expect(archived).toStrictEqual(["eligible"]);
        expect(result).toStrictEqual({ archived: 1, continueCursor: null });
    });

    it("stops at the read budget with a cursor, and a resumed pass archives what was behind it", async () => {
        const rows = [
            ...Array.from({ length: 1200 }, (_, index) => old({ _id: `archived-${index}`, status: "archived", updatedAt: CUTOFF - 1 - index })),
            old({ _id: "eligible", updatedAt: CUTOFF - 5_000_000 }),
        ];
        const fetchPage = pagedSource(rows, 200);
        const archiveIfStillDue = async () => true;

        const first = await runArchivePass({ archiveBatch: 100, archiveIfStillDue, cursor: null, fetchPage, isDue: isDueSnapshot, readBudget: 400 });

        expect(first.archived).toBe(0);
        expect(first.continueCursor).not.toBeNull();

        const resumed = await runArchivePass({
            archiveBatch: 100,
            archiveIfStillDue,
            cursor: first.continueCursor,
            fetchPage,
            isDue: isDueSnapshot,
            readBudget: 5000,
        });

        expect(resumed).toStrictEqual({ archived: 1, continueCursor: null });
    });

    it("does not count a thread the re-check declined, and keeps walking", async () => {
        const rows = [old({ _id: "changed", updatedAt: CUTOFF - 2 }), old({ _id: "still", updatedAt: CUTOFF - 1 })];
        const archived: string[] = [];

        const result = await runArchivePass({
            archiveBatch: 100,
            archiveIfStillDue: async (threadId) => {
                if (threadId === "changed") {
                    return false;
                }

                archived.push(threadId);

                return true;
            },
            cursor: null,
            fetchPage: pagedSource(rows, 200),
            isDue: isDueSnapshot,
            readBudget: 1000,
        });

        expect(archived).toStrictEqual(["still"]);
        expect(result.archived).toBe(1);
    });
});

describe("the re-check against the fresh row", () => {
    const snapshot = old({ _id: "a" });

    it("declines a thread that became active after the scan read it", () => {
        const fresh = { ...snapshot, updatedAt: CUTOFF + 10 };

        expect(selectAutoArchiveDue([fresh], CUTOFF, none, 1)).toStrictEqual([]);
    });

    it("declines a thread pinned after the scan read it", () => {
        expect(selectAutoArchiveDue([{ ...snapshot, pinnedAt: 99 }], CUTOFF, none, 1)).toStrictEqual([]);
    });

    it("declines a thread that started running after the scan read it", () => {
        expect(selectAutoArchiveDue([{ ...snapshot, status: "running" }], CUTOFF, none, 1)).toStrictEqual([]);
    });

    it("declines a thread whose project got pinned after the scan read it", () => {
        expect(selectAutoArchiveDue([{ ...snapshot, projectId: "p1" }], CUTOFF, { ...none, pinnedProjectIds: new Set(["p1"]) }, 1)).toStrictEqual([]);
    });

    it("still archives a thread that is idle as read now", () => {
        expect(selectAutoArchiveDue([snapshot], CUTOFF, none, 1)).toStrictEqual(["a"]);
    });
});
