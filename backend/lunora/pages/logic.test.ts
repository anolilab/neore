import { describe, expect, it } from "vitest";

import {
    collectSubtree,
    extractPlainText,
    isRevisionConflict,
    meetsPagePermission,
    orderBetween,
    orderForIndex,
    searchSnippet,
    snapshotAction,
    VERSION_WINDOW_MS,
    versionWindowStart,
    wouldCreateCycle,
} from "./logic";

describe("wouldCreateCycle", () => {
    // a ─ b ─ c ; d at the top level
    const parentOf = new Map<string, string | undefined>([
        ["a", undefined],
        ["b", "a"],
        ["c", "b"],
        ["d", undefined],
    ]);

    it("refuses moving a page under itself or any descendant", () => {
        expect(wouldCreateCycle("a", "a", parentOf)).toBe(true);
        expect(wouldCreateCycle("a", "b", parentOf)).toBe(true);
        expect(wouldCreateCycle("a", "c", parentOf)).toBe(true);
        expect(wouldCreateCycle("b", "c", parentOf)).toBe(true);
    });

    it("allows moving to the top level, a sibling tree, or an ancestor", () => {
        expect(wouldCreateCycle("c", null, parentOf)).toBe(false);
        expect(wouldCreateCycle("b", "d", parentOf)).toBe(false);
        expect(wouldCreateCycle("c", "a", parentOf)).toBe(false);
        expect(wouldCreateCycle("d", "c", parentOf)).toBe(false);
    });

    it("treats an already-looping chain as a cycle instead of hanging", () => {
        const corrupt = new Map<string, string | undefined>([
            ["x", "y"],
            ["y", "x"],
        ]);

        expect(wouldCreateCycle("z", "x", corrupt)).toBe(true);
    });
});

describe("ordering", () => {
    it("places between, before and after neighbours", () => {
        expect(orderBetween(undefined, undefined)).toBe(1);
        expect(orderBetween(3, undefined)).toBe(4);
        expect(orderBetween(undefined, 3)).toBe(2);
        expect(orderBetween(1, 2)).toBe(1.5);
    });

    it("maps an index among siblings to an order strictly between them", () => {
        const siblings = [1, 2, 3];

        expect(orderForIndex(siblings, 0)).toBeLessThan(1);
        expect(orderForIndex(siblings, 1)).toBe(1.5);
        expect(orderForIndex(siblings, 3)).toBeGreaterThan(3);
        expect(orderForIndex(siblings, 99)).toBeGreaterThan(3);
        expect(orderForIndex([], 0)).toBe(1);
    });
});

describe("collectSubtree", () => {
    it("returns the page first, then every descendant once", () => {
        const children = new Map([
            ["a", ["b", "c"]],
            ["b", ["d"]],
        ]);

        expect(collectSubtree("a", children)).toEqual(["a", "b", "c", "d"]);
        expect(collectSubtree("b", children)).toEqual(["b", "d"]);
    });
});

describe("version grouping", () => {
    const base = versionWindowStart(1_700_000_000_000);
    const edit = { authorId: "u1", createdAt: base + 1000, reason: "edit" as const };

    it("updates the latest snapshot for the same author inside one window", () => {
        expect(snapshotAction(edit, { authorId: "u1", now: base + VERSION_WINDOW_MS - 1, reason: "edit" })).toBe("update");
    });

    it("starts a new snapshot in the next window", () => {
        expect(snapshotAction(edit, { authorId: "u1", now: base + VERSION_WINDOW_MS, reason: "edit" })).toBe("insert");
    });

    it("starts a new snapshot for another author in the same window", () => {
        expect(snapshotAction(edit, { authorId: "u2", now: base + 2000, reason: "edit" })).toBe("insert");
    });

    it("never folds an agent edit or a restore into a window", () => {
        expect(snapshotAction(edit, { authorId: "u1", now: base + 2000, reason: "agent" })).toBe("insert");
        expect(snapshotAction(edit, { authorId: "u1", now: base + 2000, reason: "restore" })).toBe("insert");
        expect(snapshotAction({ ...edit, reason: "agent" }, { authorId: "u1", now: base + 2000, reason: "edit" })).toBe("insert");
    });

    it("inserts the first snapshot", () => {
        expect(snapshotAction(null, { authorId: "u1", now: base, reason: "edit" })).toBe("insert");
    });
});

describe("permissions", () => {
    it("orders read < comment < write < admin", () => {
        expect(meetsPagePermission("comment", "read")).toBe(true);
        expect(meetsPagePermission("read", "comment")).toBe(false);
        expect(meetsPagePermission("write", "comment")).toBe(true);
        expect(meetsPagePermission("write", "admin")).toBe(false);
        expect(meetsPagePermission("admin", "write")).toBe(true);
    });
});

describe("text", () => {
    const doc = {
        content: [
            { attrs: { level: 1 }, content: [{ text: "Title", type: "text" }], type: "heading" },
            {
                content: [
                    { text: "Hello ", type: "text" },
                    { marks: [{ type: "bold" }], text: "world", type: "text" },
                ],
                type: "paragraph",
            },
        ],
        type: "doc",
    };

    it("extracts block-separated plain text", () => {
        expect(extractPlainText(doc)).toBe("Title\nHello world");
    });

    it("finds a case-insensitive snippet", () => {
        expect(searchSnippet("Title\nHello world", "WORLD", 3)).toBe("…lo world");
        expect(searchSnippet("abc", "x")).toBeNull();
    });
});

describe("isRevisionConflict", () => {
    it("accepts the current revision and refuses one behind a content change", () => {
        expect(isRevisionConflict({ contentRevision: 3, revision: 3 }, 3)).toBe(false);
        expect(isRevisionConflict({ contentRevision: 3, revision: 3 }, 2)).toBe(true);
    });

    it("lets a base behind only comment-mark writes through", () => {
        expect(isRevisionConflict({ contentRevision: 3, revision: 5 }, 3)).toBe(false);
        expect(isRevisionConflict({ contentRevision: 4, revision: 5 }, 3)).toBe(true);
    });

    it("refuses a base from the future", () => {
        expect(isRevisionConflict({ contentRevision: 3, revision: 3 }, 4)).toBe(true);
    });
});
