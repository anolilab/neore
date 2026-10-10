import { describe, expect, it } from "vitest";

import type { GroupType, ThreadGroup } from "./types";
import { buildMatchSnippet, getGroupType, isGroupFullySelected } from "./utilities";

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
