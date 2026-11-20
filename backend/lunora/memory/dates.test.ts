/**
 * A dated memory: what the extractor's dates are kept as, how a revision keeps
 * them, and that retrieval drops a fact past its end in the user's own calendar.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { normalizeFactDates, restatementOutcome, userFactDates } from "./dates";
import { describeToday } from "./extract";
import { getActiveMemoriesForUser, updateMemoryInternal } from "./functions";

describe(normalizeFactDates, () => {
    it("drops days that are not real calendar days", () => {
        expect(normalizeFactDates({ eventStart: "2026-02-30", validUntil: "next Friday" })).toEqual({});
    });

    it("reads an end without a start as a one-day event, and drops an end that is not after its start", () => {
        expect(normalizeFactDates({ eventEnd: "2026-11-20" })).toEqual({ eventStart: "2026-11-20" });
        expect(normalizeFactDates({ eventEnd: "2026-11-19", eventStart: "2026-11-20" })).toEqual({ eventStart: "2026-11-20" });
    });
});

describe(restatementOutcome, () => {
    it.each([
        ["a dated fact restated without a date loses the date", { validUntil: "2026-11-20" }, {}, "replace"],
        ["an undated fact restated with a date gains it", {}, { validUntil: "2026-11-20" }, "replace"],
        ["an event on the same day drops its old end", { eventEnd: "2026-11-22", eventStart: "2026-11-20" }, { eventStart: "2026-11-20" }, "replace"],
        ["an event on another day is another occurrence, saved beside it", { eventStart: "2026-11-20" }, { eventStart: "2026-12-18" }, "beside"],
        ["the same dates only reconfirm", { eventStart: "2026-11-20" }, { eventStart: "2026-11-20" }, "confirm"],
        ["a pinned row is kept and the restatement saved beside it", { pinned: true, validUntil: "2026-11-20" }, {}, "beside"],
    ])("%s", (_, matched, newer, outcome) => {
        expect(restatementOutcome(matched, newer)).toBe(outcome);
    });
});

describe(userFactDates, () => {
    it("reads empty fields as cleared dates and an end on the start day as one day", () => {
        expect(userFactDates({ eventEnd: "", eventStart: "2026-11-20", validUntil: "" })).toEqual({ eventStart: "2026-11-20" });
        expect(userFactDates({ eventEnd: "2026-11-20", eventStart: "2026-11-20" })).toEqual({ eventStart: "2026-11-20" });
        expect(userFactDates({})).toEqual({});
    });

    it("refuses a day that is not real, and an event end before its start or without one", () => {
        expect(userFactDates({ validUntil: "2026-02-30" })).toBeUndefined();
        expect(userFactDates({ eventEnd: "2026-11-19", eventStart: "2026-11-20" })).toBeUndefined();
        expect(userFactDates({ eventEnd: "2026-11-19" })).toBeUndefined();
    });
});

describe(describeToday, () => {
    it("names the day in the user's timezone, not UTC", () => {
        const instant = Date.UTC(2026, 10, 17, 12, 0);

        expect(describeToday(instant, "Pacific/Auckland")).toBe("Wednesday, 2026-11-18 (Pacific/Auckland)");
        expect(describeToday(instant, undefined)).toBe("Tuesday, 2026-11-17 (UTC)");
    });
});

describe("retrieval drops expired facts", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const insert = async (memory: string, dates: Record<string, boolean | string>): Promise<void> => {
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("memories", { lastConfirmedAt: 0, memory, source: "auto", type: "context", updatedAt: 0, userId: "user-1", ...dates }),
        );
    };

    const read = async (activeOn: number): Promise<string[]> => {
        const rows = await harness.run(async (ctx: any) => await ctx.runQuery(getActiveMemoriesForUser, { activeOn, userId: "user-1" }));

        return rows.map((row: { memory: string }) => row.memory).toSorted((a: string, b: string) => a.localeCompare(b));
    };

    it("leaves out a fact whose last day has passed in the user's timezone", async () => {
        await insert("User is in Lisbon until 2026-11-17", { validUntil: "2026-11-17" });
        await insert("User flew to Paris on 2026-11-10", { eventStart: "2026-11-10" });
        await insert("User likes tea", {});
        await insert("User pinned a trip to Rome", { pinned: true, validUntil: "2026-11-01" });

        // 12:00 UTC on the 17th is already the 18th in Auckland.
        const instant = Date.UTC(2026, 10, 17, 12, 0);

        expect(await read(instant)).toEqual([
            "User flew to Paris on 2026-11-10",
            "User is in Lisbon until 2026-11-17",
            "User likes tea",
            "User pinned a trip to Rome",
        ]);

        await harness.run(async (ctx: any) => await ctx.db.insert("userSettings", { timezone: "Pacific/Auckland", userId: "user-1" }));

        // A past event stays: it still happened. A pinned fact stays: the user kept it.
        expect(await read(instant)).toEqual(["User flew to Paris on 2026-11-10", "User likes tea", "User pinned a trip to Rome"]);
    });

    it("finds a live fact behind more expired rows than one page holds", async () => {
        await insert("User likes tea", {});

        for (let i = 0; i < 8; i += 1) {
            await insert(`User was in Lisbon, trip ${String(i)}`, { validUntil: "2026-11-01" });
        }

        const rows = await harness.run(
            async (ctx: any) => await ctx.runQuery(getActiveMemoriesForUser, { activeOn: Date.UTC(2026, 10, 17, 12, 0), limit: 2, userId: "user-1" }),
        );

        expect(rows.map((row: { memory: string }) => row.memory)).toEqual(["User likes tea"]);
    });

    it("drops the old event end when an update moves the event to a single day", async () => {
        const id = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("memories", {
                    eventEnd: "2026-11-22",
                    eventStart: "2026-11-20",
                    lastConfirmedAt: 0,
                    memory: "User is at a conference",
                    type: "context",
                    userId: "user-1",
                    validUntil: "2026-11-22",
                }),
        );

        // A revision moves the event to one day and says nothing of an end: both old end dates go.
        await harness.run(async (ctx: any) => await ctx.runMutation(updateMemoryInternal, { dates: { eventStart: "2026-11-28" }, memoryId: id }));

        const row = await harness.run(async (ctx: any) => await ctx.db.get("memories", id));

        expect(row).toMatchObject({ eventStart: "2026-11-28" });
        expect(row.eventEnd).toBeUndefined();
        expect(row.validUntil).toBeUndefined();
    });
});

describe("a malformed event start", () => {
    it("drops the event's dates rather than moving the event to its end day", () => {
        expect(normalizeFactDates({ eventEnd: "2026-11-20", eventStart: "next week" })).toEqual({});
        expect(normalizeFactDates({ eventEnd: "2026-11-20", eventStart: "" })).toEqual({ eventStart: "2026-11-20" });
    });
});
