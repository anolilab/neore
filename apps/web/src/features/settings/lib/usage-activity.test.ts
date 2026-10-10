import { describe, expect, it } from "vitest";

import {
    addDays,
    buildHeatmap,
    daysBetween,
    formatUsd,
    HEATMAP_WEEKS,
    levelOf,
    levelThresholds,
    localDayKey,
    periodStart,
    stepDay,
    weekdayOf,
} from "./usage-activity";

const day = (date: string, replies: number, costMicrodollars = replies * 1000) => {
    return { costMicrodollars, date, replies, tokens: replies * 10 };
};

describe("day keys", () => {
    it("formats the browser's local calendar day", () => {
        expect(localDayKey(new Date(2026, 8, 5, 23, 59))).toBe("2026-09-05");
    });

    it("shifts and reads weekdays Monday-first", () => {
        expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
        expect(weekdayOf("2026-09-21")).toBe(0); // Monday
        expect(weekdayOf("2026-09-27")).toBe(6); // Sunday
        expect(periodStart("2026-09-25", 7)).toBe("2026-09-19");
        expect(periodStart("2026-09-25", 1)).toBe("2026-09-25");
        expect(daysBetween("2025-09-22", "2026-09-25")).toBe(368);
        expect(daysBetween("2026-09-25", "2026-09-24")).toBe(-1);
    });
});

describe("levels", () => {
    it("splits the positive values into terciles", () => {
        const thresholds = levelThresholds([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

        expect(thresholds).toStrictEqual([3, 6]);
        expect(levelOf(0, thresholds)).toBe(0);
        expect(levelOf(1, thresholds)).toBe(1);
        expect(levelOf(3, thresholds)).toBe(1);
        expect(levelOf(4, thresholds)).toBe(2);
        expect(levelOf(9, thresholds)).toBe(3);
    });

    it("puts a single active value at the lowest level", () => {
        const thresholds = levelThresholds([5]);

        expect(levelOf(5, thresholds)).toBe(1);
    });

    it("has no active level without positive values", () => {
        expect(levelThresholds([])).toStrictEqual([0, 0]);
    });
});

describe("buildHeatmap", () => {
    const today = "2026-09-25"; // a Friday

    it("draws 53 Monday-first weeks ending with today's week, blanking the days after today", () => {
        const model = buildHeatmap([], today, "replies");

        expect(model.weeks).toHaveLength(HEATMAP_WEEKS);
        expect(model.weeks.every((week) => week.length === 7)).toBe(true);
        expect(model.fromDate).toBe("2025-09-22");
        expect(weekdayOf(model.fromDate)).toBe(0);

        const last = model.weeks.at(-1)!;

        expect(last.map((cell) => cell.inRange)).toStrictEqual([true, true, true, true, true, false, false]);
        expect(last[4]!.date).toBe(today);
    });

    it("totals the window and ignores days outside it", () => {
        const model = buildHeatmap([day("2025-09-21", 50), day("2025-09-22", 1), day(today, 4, 9000), day("2026-09-26", 70)], today, "replies");

        expect(model.totalReplies).toBe(5);
        expect(model.totalCostMicrodollars).toBe(10_000);
        expect(model.activeDays).toBe(2);
        expect(model.weeks[0]![0]).toMatchObject({ date: "2025-09-22", replies: 1 });
    });

    it("buckets by the chosen metric", () => {
        const days = [day("2026-09-21", 1, 900), day("2026-09-22", 2, 10), day("2026-09-23", 9, 20)];
        const byReplies = buildHeatmap(days, today, "replies").weeks.at(-1)!;
        const byCost = buildHeatmap(days, today, "cost").weeks.at(-1)!;

        expect(byReplies.slice(0, 3).map((cell) => cell.level)).toStrictEqual([1, 2, 3]);
        expect(byCost.slice(0, 3).map((cell) => cell.level)).toStrictEqual([3, 1, 2]);
    });

    it("summarises per month and labels the week each month starts in", () => {
        const model = buildHeatmap([day("2026-08-31", 2), day("2026-09-01", 3), day("2026-09-02", 1)], today, "replies");

        expect(model.months.at(-1)).toStrictEqual({ activeDays: 2, costMicrodollars: 4000, month: "2026-09", replies: 4 });
        expect(model.months.at(-2)).toMatchObject({ activeDays: 1, month: "2026-08", replies: 2 });
        expect(model.months).toHaveLength(13);

        const september = model.monthStarts.find((start) => start.month === "2026-09")!;

        expect(model.weeks[september.weekIndex]![0]!.date).toBe("2026-09-07");
        // The first column (Sep 22, 2025) is too close to October's label to carry its own.
        expect(model.monthStarts[0]!.month).toBe("2025-10");
    });
});

describe("stepDay", () => {
    const model = { fromDate: "2025-09-22", toDate: "2026-09-25" };

    it("moves a day vertically and a week horizontally, clamped to the window", () => {
        expect(stepDay("2026-09-10", "ArrowDown", model)).toBe("2026-09-11");
        expect(stepDay("2026-09-10", "ArrowUp", model)).toBe("2026-09-09");
        expect(stepDay("2026-09-10", "ArrowRight", model)).toBe("2026-09-17");
        expect(stepDay("2026-09-22", "ArrowRight", model)).toBe("2026-09-25");
        expect(stepDay("2025-09-24", "ArrowLeft", model)).toBe("2025-09-22");
        expect(stepDay("2026-01-01", "Home", model)).toBe("2025-09-22");
        expect(stepDay("2026-01-01", "End", model)).toBe("2026-09-25");
        expect(stepDay("2026-01-01", "Enter", model)).toBeUndefined();
    });
});

describe("formatUsd", () => {
    it("shows sub-dollar spend with four decimals", () => {
        expect(formatUsd(1234, "en")).toBe("$0.0012");
        expect(formatUsd(0, "en")).toBe("$0.00");
        expect(formatUsd(12_345_678, "en")).toBe("$12.35");
    });
});
