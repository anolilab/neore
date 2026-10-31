import { describe, expect, it } from "vitest";

import type { Versioned } from "./merge";
import { isAtLeastAsNew, mergeRows } from "./merge";

const row = (id: string, updatedAt: number, syncedAt: number, text = id): Versioned & { text: string } => {
    return { id, syncedAt, text, updatedAt };
};

describe("isAtLeastAsNew", () => {
    it("prefers the later updatedAt whatever the sync times say", () => {
        expect(isAtLeastAsNew(row("a", 20, 1), row("a", 10, 99))).toBe(true);
        expect(isAtLeastAsNew(row("a", 10, 99), row("a", 20, 1))).toBe(false);
    });

    it("breaks an updatedAt tie with the later syncedAt", () => {
        expect(isAtLeastAsNew(row("a", 10, 5), row("a", 10, 4))).toBe(true);
        expect(isAtLeastAsNew(row("a", 10, 4), row("a", 10, 5))).toBe(false);
    });

    it("lets an identical stamp replace, so a repeat save is a no-op", () => {
        expect(isAtLeastAsNew(row("a", 10, 5), row("a", 10, 5))).toBe(true);
    });
});

describe("mergeRows", () => {
    it("never lets an older cached row replace a newer live one", () => {
        const live = [row("a", 200, 1000, "live")];
        const cached = [row("a", 100, 500, "cached")];

        expect(mergeRows(live, cached)).toEqual([row("a", 200, 1000, "live")]);
    });

    it("keeps the live row when the cached copy only has an older sync time", () => {
        const merged = mergeRows([row("a", 100, 1000, "live")], [row("a", 100, 500, "cached")]);

        expect(merged[0]?.text).toBe("live");
    });

    it("takes a cached row that is genuinely newer than the live one", () => {
        const merged = mergeRows([row("a", 100, 1000, "live")], [row("a", 300, 400, "cached")]);

        expect(merged[0]?.text).toBe("cached");
    });

    it("does not delete a live row the cache lacks", () => {
        const live = [row("a", 1, 1), row("b", 2, 1)];

        expect(mergeRows(live, [row("a", 1, 1)]).map((entry) => entry.id)).toEqual(["a", "b"]);
        expect(mergeRows(live, [])).toEqual(live);
    });

    it("does not delete a cached row the live data lacks", () => {
        const merged = mergeRows([row("a", 1, 1)], [row("a", 1, 1), row("old", 0, 0)]);

        expect(merged.map((entry) => entry.id)).toEqual(["a", "old"]);
    });

    it("lists each id once", () => {
        const merged = mergeRows([row("a", 2, 2), row("a", 1, 1)], [row("a", 0, 0)]);

        expect(merged).toHaveLength(1);
        expect(merged[0]?.updatedAt).toBe(2);
    });
});
