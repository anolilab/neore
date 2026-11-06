import { describe, expect, it } from "vitest";

import { COMPACT_KEEP_TURNS, compactionFoldCount, compactThresholdTokens, dropCompactedRows } from "./thread-compaction-logic";

const rowsOfTurns = (turns: number) =>
    Array.from({ length: turns * 2 }, (_, index) => {
        return { _id: `r${index}`, order: Math.floor(index / 2), stepOrder: index % 2 };
    });

describe("compactionFoldCount", () => {
    it("folds every row before the last turns that stay verbatim", () => {
        expect.assertions(1);

        // Ten turns, anchored at the last: the last COMPACT_KEEP_TURNS turns stay.
        expect(compactionFoldCount(rowsOfTurns(10), 9)).toBe((10 - COMPACT_KEEP_TURNS) * 2);
    });

    it("never splits a turn: rows sharing an order are folded or kept together", () => {
        expect.assertions(1);

        expect(compactionFoldCount(rowsOfTurns(5), 4) % 2).toBe(0);
    });

    it("keeps the prompt's own turn when it is the anchor of an auto-compact", () => {
        expect.assertions(1);

        // The prompt (order 4) is saved already; rows of orders 0-2 fold, 3 and 4 stay.
        expect(compactionFoldCount(rowsOfTurns(5), 4)).toBe(6);
    });

    it("folds nothing when the thread is too short to be worth a call", () => {
        expect.assertions(2);

        expect(compactionFoldCount(rowsOfTurns(2), 1)).toBe(0);
        expect(compactionFoldCount([], 0)).toBe(0);
    });
});

describe("dropCompactedRows", () => {
    it("drops everything up to and including the boundary row", () => {
        expect.assertions(1);

        const kept = dropCompactedRows(rowsOfTurns(3), { messageId: "r2", order: 1, stepOrder: 0 });

        expect(kept.map((row) => row._id)).toStrictEqual(["r3", "r4", "r5"]);
    });

    it("falls back to the storage position when the window no longer holds the boundary row", () => {
        expect.assertions(1);

        const kept = dropCompactedRows(rowsOfTurns(3), { messageId: "gone", order: 1, stepOrder: 0 });

        expect(kept.map((row) => row._id)).toStrictEqual(["r3", "r4", "r5"]);
    });

    it("keeps the whole window when the boundary is older than every row in it", () => {
        expect.assertions(1);

        expect(dropCompactedRows(rowsOfTurns(2), { messageId: "old", order: -1, stepOrder: 0 })).toHaveLength(4);
    });
});

describe("compactThresholdTokens", () => {
    it("is the share of the model's window the setting names", () => {
        expect.assertions(1);

        expect(compactThresholdTokens(200_000, 80)).toBe(160_000);
    });

    it.each([undefined, 0, 49, -5])("is off for %s", (percent) => {
        expect.assertions(1);

        expect(compactThresholdTokens(200_000, percent)).toBeUndefined();
    });

    it("is off for a window it does not know", () => {
        expect.assertions(1);

        expect(compactThresholdTokens(0, 80)).toBeUndefined();
    });

    it("caps a threshold above the range at its highest", () => {
        expect.assertions(1);

        expect(compactThresholdTokens(100_000, 99)).toBe(95_000);
    });
});
