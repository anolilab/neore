import type { ReviewThread, ViewedState } from "@neore/backend/source-control/types";
import { describe, expect, it } from "vitest";

import { countViewed, groupByLine, lineKey, threadLineKey, unplacedThreads, VERDICT_CAPABILITIES, viewedStatesOf } from "./review";

const thread = (overrides: Partial<ReviewThread> = {}): ReviewThread => {
    return {
        canResolve: true,
        canUnresolve: false,
        comments: [],
        id: "T1",
        isOutdated: false,
        isResolved: false,
        line: 12,
        path: "a.ts",
        side: "new",
        startLine: null,
        ...overrides,
    };
};

describe("review helpers", () => {
    it("keys a line by side and number, so the same number on the two sides is two lines", () => {
        expect(lineKey("new", 4)).not.toBe(lineKey("old", 4));
        expect(threadLineKey(thread({ line: 4, side: "old" }))).toBe(lineKey("old", 4));
        expect(threadLineKey(thread({ line: null }))).toBeNull();
    });

    it("groups by line and leaves out what has none", () => {
        const groups = groupByLine([thread({ id: "1" }), thread({ id: "2" }), thread({ id: "3", line: null }), thread({ id: "4", line: 5 })], threadLineKey);

        expect(groups.get(lineKey("new", 12))?.map((entry) => entry.id)).toEqual(["1", "2"]);
        expect(groups.get(lineKey("new", 5))?.map((entry) => entry.id)).toEqual(["4"]);
        expect(groups.size).toBe(2);
    });

    it("finds the threads that sit on no line shown", () => {
        const placed = new Set([lineKey("new", 12)]);

        expect(
            unplacedThreads([thread({ id: "on" }), thread({ id: "gone", line: null }), thread({ id: "cut", line: 99 })], placed).map((entry) => entry.id),
        ).toEqual(["gone", "cut"]);
    });

    it("counts only the files marked viewed, not those changed since", () => {
        const states = new Map<string, ViewedState>([
            ["a", "viewed"],
            ["b", "changed"],
            ["c", "unviewed"],
        ]);

        expect(countViewed(["a", "b", "c", "d"], states)).toBe(1);
    });

    it("reads the viewed states of the pages that loaded", () => {
        const states = viewedStatesOf([
            { files: [{ path: "a", state: "viewed" }], status: "ok" },
            { status: "rate_limited" },
            { files: [{ path: "b", state: "changed" }], status: "ok" },
        ]);

        expect([...states]).toEqual([
            ["a", "viewed"],
            ["b", "changed"],
        ]);
    });

    it("gates every verdict on its own capability", () => {
        expect(Object.values(VERDICT_CAPABILITIES).toSorted((a, b) => a.localeCompare(b))).toEqual([
            "review.verdictApprove",
            "review.verdictComment",
            "review.verdictRequestChanges",
        ]);
    });
});
