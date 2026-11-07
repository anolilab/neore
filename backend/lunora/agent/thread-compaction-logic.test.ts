import { describe, expect, it } from "vitest";

import { COMPACT_KEEP_TURNS, compactionFoldCount, compactThresholdTokens, dropCompactedRows } from "./thread-compaction-logic";

const rowsOfTurns = (turns: number) =>
    Array.from({ length: turns * 2 }, (_, index) => {
        return { _id: `r${index}`, order: Math.floor(index / 2), role: index % 2 === 0 ? "user" : "assistant", stepOrder: index % 2 };
    });

describe("compactionFoldCount", () => {
    it("folds every row before the last turns that stay verbatim", () => {
        expect.assertions(1);

        expect(compactionFoldCount(rowsOfTurns(10))).toBe((10 - COMPACT_KEEP_TURNS) * 2);
    });

    it("never splits a turn: rows sharing an order are folded or kept together", () => {
        expect.assertions(1);

        expect(compactionFoldCount(rowsOfTurns(5)) % 2).toBe(0);
    });

    it("keeps exactly the last exchanges at the boundary: one more than kept folds one, as many as kept folds none", () => {
        expect.assertions(2);

        expect(compactionFoldCount(rowsOfTurns(COMPACT_KEEP_TURNS + 1))).toBe(2);
        expect(compactionFoldCount(rowsOfTurns(COMPACT_KEEP_TURNS))).toBe(0);
    });

    it("counts exchanges, not orders, when the path's orders have gaps", () => {
        expect.assertions(1);

        // Orders 0, 1, 7 and 12: a continuation and a sibling branch took the orders between them.
        const rows = [
            { order: 0, role: "user" },
            { order: 0, role: "assistant" },
            { order: 1, role: "user" },
            { order: 1, role: "assistant" },
            { order: 7, role: "user" },
            { order: 7, role: "assistant" },
            { order: 12, role: "user" },
            { order: 12, role: "assistant" },
        ];

        expect(compactionFoldCount(rows)).toBe(4);
    });

    it("keeps a continuation under a later order with the exchange it continues", () => {
        expect.assertions(1);

        // Exchange 2's tool approval continued under order 3, with no user row of its own.
        const rows = [
            { order: 0, role: "user" },
            { order: 0, role: "assistant" },
            { order: 1, role: "user" },
            { order: 1, role: "assistant" },
            { order: 2, role: "user" },
            { order: 2, role: "assistant" },
            { order: 3, role: "tool" },
            { order: 3, role: "assistant" },
            { order: 4, role: "user" },
            { order: 4, role: "assistant" },
        ];

        // Exchanges at orders 2 (with its continuation) and 4 stay; orders 0 and 1 fold.
        expect(compactionFoldCount(rows)).toBe(4);
    });

    it("folds nothing when the thread is too short to be worth a call", () => {
        expect.assertions(2);

        expect(compactionFoldCount(rowsOfTurns(2))).toBe(0);
        expect(compactionFoldCount([])).toBe(0);
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
