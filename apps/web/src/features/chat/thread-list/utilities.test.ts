import { describe, expect, it } from "vitest";

import type { GroupType, ThreadGroup } from "./types";
import { buildMatchSnippet, getGroupType, isGroupFullySelected, isInPlaceholderGroup, selectThreadIdsByDate } from "./utilities";

describe("getGroupType", () => {
    it("should return groupType when available", () => {
        const group = { groupType: "pinned" as GroupType, title: "Anything" } as ThreadGroup;

        expect(getGroupType(group)).toBe("pinned");
    });

    it("should prefer groupType over title match", () => {
        const group = { groupType: "today" as GroupType, title: "Archived" } as ThreadGroup;

        expect(getGroupType(group)).toBe("today");
    });

    it("should return 'project' when projectId is set", () => {
        const group = { projectId: "proj_123", title: "My Project" } as ThreadGroup;

        expect(getGroupType(group)).toBe("project");
    });

    describe("title-based fallback", () => {
        const cases: [string, GroupType][] = [
            ["Archived", "archived"],
            ["Last 7 days", "last7days"],
            ["Last month", "lastMonth"],
            ["Pinned", "pinned"],
            ["Temporary", "temporary"],
            ["Today", "today"],
        ];

        for (const [title, expected] of cases) {
            it(`should return '${expected}' for title '${title}'`, () => {
                const group = { title } as ThreadGroup;

                expect(getGroupType(group)).toBe(expected);
            });
        }

        it("should return 'older' for unknown titles", () => {
            expect(getGroupType({ title: "Unknown" } as ThreadGroup)).toBe("older");
            expect(getGroupType({ title: "" } as ThreadGroup)).toBe("older");
            expect(getGroupType({ title: "Custom Group" } as ThreadGroup)).toBe("older");
        });
    });
});

describe("isGroupFullySelected", () => {
    it("should return true when all threads are selected", () => {
        const groupIds = ["a", "b", "c"];
        const selected = new Set(["a", "b", "c", "d"]);

        expect(isGroupFullySelected(groupIds, selected)).toBe(true);
    });

    it("should return false when some threads are not selected", () => {
        const groupIds = ["a", "b", "c"];
        const selected = new Set(["a", "b"]);

        expect(isGroupFullySelected(groupIds, selected)).toBe(false);
    });

    it("should return false for empty group", () => {
        expect(isGroupFullySelected([], new Set(["a"]))).toBe(false);
    });

    it("should return false when no threads are selected", () => {
        expect(isGroupFullySelected(["a", "b"], new Set())).toBe(false);
    });

    it("should return true for single thread group when selected", () => {
        expect(isGroupFullySelected(["a"], new Set(["a"]))).toBe(true);
    });
});

describe(buildMatchSnippet, () => {
    it("centres the excerpt on the match and marks both cuts", () => {
        const text = `${"a ".repeat(50)}needle${" b".repeat(50)}`;

        expect(buildMatchSnippet(text, "NEEDLE", 4)).toBe("…a a needle b b…");
    });

    it("keeps short text whole and collapses whitespace", () => {
        expect(buildMatchSnippet("find\n  the needle", "needle")).toBe("find the needle");
    });

    it("falls back to the start when the query is not verbatim", () => {
        expect(buildMatchSnippet("abcdefghij", "zzz", 2)).toBe("abcd…");
    });
});

describe("selectThreadIdsByDate", () => {
    // Local midnight, so the day boundaries match what the date inputs mean.
    const at = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).getTime();
    const thread = (threadId: string, lastActive: number, extra: { isPinned?: boolean; updatedAt?: number } = {}) => {
        return {
            createdAt: lastActive,
            isPinned: extra.isPinned,
            threadId,
            updatedAt: extra.updatedAt,
        };
    };

    it("selects threads active on or before the to day, including its last moment", () => {
        const threads = [thread("early", at(2026, 10, 1)), thread("edge", at(2026, 10, 15, 23)), thread("late", at(2026, 10, 16, 0))];

        expect(selectThreadIdsByDate(threads, { from: "", to: "2026-10-15" })).toEqual(["early", "edge"]);
    });

    it("treats from as the start of its day and to as inclusive", () => {
        const threads = [
            thread("before", at(2026, 10, 9, 23)),
            thread("first", at(2026, 10, 10, 0)),
            thread("last", at(2026, 10, 12, 23)),
            thread("after", at(2026, 10, 13, 0)),
        ];

        expect(selectThreadIdsByDate(threads, { from: "2026-10-10", to: "2026-10-12" })).toEqual(["first", "last"]);
    });

    it("parses the day as local time, not UTC", () => {
        // 00:30 local on the 10th is the 9th in UTC for any zone east of UTC; the local day must still hold it.
        const threads = [thread("start", at(2026, 10, 10, 0))];

        expect(selectThreadIdsByDate(threads, { from: "2026-10-10", to: "" })).toEqual(["start"]);
    });

    it("uses updatedAt when the row recorded it, else createdAt", () => {
        const threads = [
            { createdAt: at(2026, 1, 1), threadId: "old-but-active", updatedAt: at(2026, 10, 18) },
            { createdAt: at(2026, 10, 18), threadId: "new-but-idle", updatedAt: at(2026, 1, 1) },
            { createdAt: at(2026, 1, 1), threadId: "no-updatedAt" },
        ];

        expect(selectThreadIdsByDate(threads, { from: "2026-10-01", to: "" })).toEqual(["old-but-active"]);
        expect(selectThreadIdsByDate(threads, { from: "", to: "2026-03-01" })).toEqual(["new-but-idle", "no-updatedAt"]);
    });

    it("skips pinned threads", () => {
        const october = at(2026, 10, 1);
        const threads = [thread("pinned", october, { isPinned: true }), thread("plain", october)];

        expect(selectThreadIdsByDate(threads, { from: "", to: "2026-10-31" })).toEqual(["plain"]);
    });

    it("selects nothing when neither bound is set", () => {
        const threads = [thread("a", at(2026, 10, 1))];

        expect(selectThreadIdsByDate(threads, { from: "", to: "" })).toEqual([]);
    });
});

describe("isInPlaceholderGroup", () => {
    const groups = [
        { isPlaceholder: true, threads: [{ threadId: "held" }], title: "Projects" },
        { threads: [{ threadId: "free" }], title: "Today" },
    ] as unknown as ThreadGroup[];

    it("flags threads of a placeholder group only, so a drag from or onto them is ignored", () => {
        expect(isInPlaceholderGroup(groups, "held")).toBe(true);
        expect(isInPlaceholderGroup(groups, "free")).toBe(false);
        expect(isInPlaceholderGroup(groups, "project-p1")).toBe(false);
    });
});
