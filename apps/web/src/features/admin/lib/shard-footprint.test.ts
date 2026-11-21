import { describe, expect, it } from "vitest";

import type { BreakdownEntry, FootprintTotals } from "./shard-footprint";
import { NO_TOTALS, readingsOf, sumTotals } from "./shard-footprint";

const entry = (group: BreakdownEntry["group"], sinceDays: number, threads: number, toolBytes = 0): BreakdownEntry => {
    return {
        approxBytes: threads * 100,
        group,
        largeToolBytes: toolBytes,
        largeToolRows: toolBytes > 0 ? 1 : 0,
        messageRows: threads * 2,
        sinceDays,
        threads,
        toolBytes,
    };
};

const page = (fields: Partial<FootprintTotals>): FootprintTotals => {
    return { ...NO_TOTALS, ...fields };
};

describe("sumTotals", () => {
    it("adds counts, sums the breakdown by group and age band, and keeps the largest numbers", () => {
        const sum = sumTotals([
            page({ breakdown: [entry("active", 0, 2)], largestShardBytes: [500, 10], largestThreadRows: [40, 3], shards: 2, threads: 2 }),
            page({ breakdown: [entry("active", 0, 1), entry("archived", 90, 4)], largestShardBytes: [200], largestThreadRows: [9], shards: 1, threads: 5 }),
        ]);

        expect(sum).toMatchObject({ largestShardBytes: [500, 200, 10], largestThreadRows: [40, 9, 3], shards: 3, threads: 7 });
        expect(sum.breakdown).toEqual([entry("active", 0, 3), entry("archived", 90, 4)]);
    });

    it("does not change the pages it sums", () => {
        const first = page({ breakdown: [entry("active", 0, 2)] });

        sumTotals([first, page({ breakdown: [entry("active", 0, 1)] })]);

        expect(first.breakdown).toEqual([entry("active", 0, 2)]);
    });
});

describe("readingsOf", () => {
    const breakdown = [
        entry("active", 0, 5),
        entry("active", 7, 3),
        entry("active", 30, 2, 1000),
        entry("archived", 30, 4),
        entry("archived", 365, 1, 500),
        entry("pinned", 90, 1, 200),
        entry("other", 3, 6),
    ];
    const readings = readingsOf(breakdown);

    it("counts archived threads archived at least each window", () => {
        expect(readings.archived.map((row) => [row.sinceDays, row.threads])).toEqual([
            [0, 5],
            [30, 5],
            [90, 1],
            [365, 1],
        ]);
    });

    it("counts active threads idle at least each settle choice, leaving archived and pinned out", () => {
        expect(readings.idle.map((row) => [row.sinceDays, row.threads])).toEqual([
            [3, 5],
            [7, 5],
            [14, 2],
            [30, 2],
        ]);
    });

    it("counts compactable tool output in threads idle at least 30 days, never in other", () => {
        expect(readings.compactable).toMatchObject({ largeToolBytes: 1700, largeToolRows: 3, toolBytes: 1700 });
        expect(readings.other.threads).toBe(6);
        expect(readings.pinned.threads).toBe(1);
        expect(readings.kept.threads).toBe(16);
    });
});
