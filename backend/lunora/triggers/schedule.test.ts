import { describe, expect, it } from "vitest";

import { cronZoneOf, dueScheduleStep, findNextCronTime, getNextCronTime, isHourlyOrSlowerCronExpression, isValidCronExpression } from "./schedule";

describe("getNextCronTime", () => {
    // Use a fixed reference: 2026-03-12 10:30:00 UTC (Thursday, dow=4)
    const REF = new Date("2026-03-12T10:30:00Z").getTime();

    it("should return the next minute for '* * * * *'", () => {
        const next = getNextCronTime("* * * * *", REF);

        expect(next).toBe(new Date("2026-03-12T10:31:00Z").getTime());
    });

    it("should parse specific minute values", () => {
        // "45 * * * *" — next :45 after 10:30 is 10:45
        const next = getNextCronTime("45 * * * *", REF);

        expect(new Date(next).getMinutes()).toBe(45);
        expect(next).toBe(new Date("2026-03-12T10:45:00Z").getTime());
    });

    it("should parse step expressions (*/15)", () => {
        // "*/15 * * * *" — minutes 0,15,30,45 — next after 10:30 is 10:45
        const next = getNextCronTime("*/15 * * * *", REF);

        expect(new Date(next).getMinutes()).toBe(45);
    });

    it("should parse range expressions (9-17)", () => {
        // "0 9-17 * * *" — every hour at :00 from 9-17 — next after 10:30 is 11:00
        const next = getNextCronTime("0 9-17 * * *", REF);

        expect(new Date(next).getUTCHours()).toBe(11);
        expect(new Date(next).getUTCMinutes()).toBe(0);
    });

    it("should parse comma-separated lists", () => {
        // "0 8,12,18 * * *" — next after 10:30 is 12:00
        const next = getNextCronTime("0 8,12,18 * * *", REF);
        const d = new Date(next);

        expect(d.getUTCHours()).toBe(12);
        expect(d.getUTCMinutes()).toBe(0);
    });

    it("should handle day-of-week filtering", () => {
        // "0 9 * * 1" — Mondays at 09:00 — ref is Thursday, so next Monday
        const next = getNextCronTime("0 9 * * 1", REF);
        const d = new Date(next);

        expect(d.getDay()).toBe(1); // Monday
    });

    it("should return fallback (1h) for invalid expressions", () => {
        expect(getNextCronTime("invalid", REF)).toBe(REF + 3_600_000);
        expect(getNextCronTime("* *", REF)).toBe(REF + 3_600_000);
        expect(getNextCronTime("", REF)).toBe(REF + 3_600_000);
    });

    it("should handle step=0 gracefully (no infinite loop)", () => {
        // "0/0 * * * *" — step=0 is invalid, should fall back to wildcard
        const next = getNextCronTime("0/0 * * * *", REF);

        expect(next).toBeGreaterThan(REF);
    });

    it("should handle month filtering", () => {
        // "0 0 1 4 *" — midnight on April 1st — within 31-day window from March 12
        const next = getNextCronTime("0 0 1 4 *", REF);
        const d = new Date(next);

        expect(d.getMonth()).toBe(3); // April (0-indexed)
        expect(d.getDate()).toBe(1);
    });

    it("finds a run months beyond the old 31-day window", () => {
        // "0 0 1 12 *" — December is ~9 months away. It used to fall back to one hour from now.
        const next = getNextCronTime("0 0 1 12 *", REF);

        expect(next).toBe(new Date("2026-12-01T00:00:00Z").getTime());
    });

    it("rejects an expression with an unknown field instead of reading it as a wildcard", () => {
        expect(findNextCronTime("bad 0 * * *", NOW)).toBeUndefined();
    });

    it("returns undefined from findNextCronTime when the schedule never fires", () => {
        // Feb 30 does not exist, so no fallback may be armed as a due run.
        expect(findNextCronTime("0 0 30 2 *", REF)).toBeUndefined();
    });

    it("finds Feb 29 on a leap year within the search window", () => {
        expect(findNextCronTime("0 0 29 2 *", REF)).toBe(new Date("2028-02-29T00:00:00Z").getTime());
    });

    it("should always return a time after the reference", () => {
        const expressions = ["* * * * *", "0 0 * * *", "30 10 * * *", "*/5 * * * *"];

        for (const expression of expressions) {
            expect(getNextCronTime(expression, REF)).toBeGreaterThan(REF);
        }
    });
});

describe(isValidCronExpression, () => {
    it("accepts the schedule format and refuses anything the parser would read as a wildcard", () => {
        for (const valid of ["0 9 * * 1", "*/15 * * * *", "0 8,12,18 * * *", "0 9 1-5 * *", "30 23 31 12 6"]) {
            expect(isValidCronExpression(valid), valid).toBe(true);
        }

        for (const invalid of [
            "",
            "* * * *",
            "0 9 * * * *",
            "60 * * * *",
            "0 24 * * *",
            "0 0 0 * *",
            "0 0 * 13 *",
            "0 0 * * 7",
            "*/0 * * * *",
            "a b c d e",
            "5-1 * * * *",
            "1-5/2 * * * *",
        ]) {
            expect(isValidCronExpression(invalid), invalid).toBe(false);
        }
    });
});

describe("isHourlyOrSlowerCronExpression", () => {
    it("accepts expressions that fire at most once an hour", () => {
        expect(isHourlyOrSlowerCronExpression("0 9 * * 1")).toBe(true);
        expect(isHourlyOrSlowerCronExpression("30 * * * *")).toBe(true);
        expect(isHourlyOrSlowerCronExpression("0 */2 * * *")).toBe(true);
    });

    it("refuses any minute field that repeats within an hour", () => {
        expect(isHourlyOrSlowerCronExpression("* * * * *")).toBe(false);
        expect(isHourlyOrSlowerCronExpression("*/5 * * * *")).toBe(false);
        expect(isHourlyOrSlowerCronExpression("0,30 * * * *")).toBe(false);
        expect(isHourlyOrSlowerCronExpression("0-30 * * * *")).toBe(false);
    });

    it("refuses anything that is not a valid 5-field expression", () => {
        expect(isHourlyOrSlowerCronExpression("")).toBe(false);
        expect(isHourlyOrSlowerCronExpression("0 9 * *")).toBe(false);
    });
});

const NOW = new Date("2026-03-12T10:30:00Z").getTime();
const AT_MOST_HOURLY_RE = /at most hourly/;

describe("dueScheduleStep", () => {
    it("switches off a per-minute schedule instead of running it", () => {
        const step = dueScheduleStep("* * * * *", NOW);

        expect(step).toMatchObject({ kind: "switchOff" });
        expect(step.kind === "switchOff" && step.reason).toMatch(AT_MOST_HOURLY_RE);
    });

    it("switches off a schedule that never fires", () => {
        expect(dueScheduleStep("0 0 30 2 *", NOW)).toMatchObject({ kind: "switchOff" });
    });

    it("runs an hourly schedule and arms its next time", () => {
        expect(dueScheduleStep("30 * * * *", NOW)).toEqual({ kind: "run", nextTime: findNextCronTime("30 * * * *", NOW) });
    });

    it("runs a trigger that has no cron expression without arming a time", () => {
        expect(dueScheduleStep(undefined, NOW)).toEqual({ kind: "run" });
    });
});

describe("findNextCronTime in a time zone", () => {
    const at = (iso: string): number => Date.parse(iso);
    const NEW_YORK = "America/New_York";
    const BERLIN = "Europe/Berlin";

    it("reads the fields as local time", () => {
        // 09:00 in New York is 13:00Z in summer time and 14:00Z in winter time.
        expect(findNextCronTime("0 9 * * *", at("2026-07-01T00:00:00Z"), NEW_YORK)).toBe(at("2026-07-01T13:00:00Z"));
        expect(findNextCronTime("0 9 * * *", at("2026-01-15T00:00:00Z"), NEW_YORK)).toBe(at("2026-01-15T14:00:00Z"));
    });

    it("matches day of month and weekday on the local date", () => {
        // Monday 00:00 in Tokyo (UTC+9) is Sunday 15:00Z.
        expect(findNextCronTime("0 0 * * 1", at("2026-03-12T00:00:00Z"), "Asia/Tokyo")).toBe(at("2026-03-15T15:00:00Z"));
        // The 1st at 00:30 in Los Angeles (UTC-7 in May) is the 1st at 07:30Z.
        expect(findNextCronTime("30 0 1 * *", at("2026-05-02T00:00:00Z"), "America/Los_Angeles")).toBe(at("2026-06-01T07:30:00Z"));
    });

    it("starts from the local date when it differs from the UTC date", () => {
        // 2026-03-12T03:00Z is still the 11th (23:00) in New York, so 23:30 is the same evening.
        expect(findNextCronTime("30 23 * * *", at("2026-03-12T03:00:00Z"), NEW_YORK)).toBe(at("2026-03-12T03:30:00Z"));
    });

    describe("spring forward", () => {
        it("runs a time inside the gap just after it, in a zone behind UTC", () => {
            // 2026-03-08 02:30 does not exist in New York; the clocks jump from 02:00 EST to 03:00 EDT.
            expect(findNextCronTime("30 2 * * *", at("2026-03-08T00:00:00Z"), NEW_YORK)).toBe(at("2026-03-08T07:30:00Z"));
        });

        it("runs a time inside the gap just after it, in a zone ahead of UTC", () => {
            // 2026-03-29 02:30 does not exist in Berlin; the clocks jump from 02:00 CET to 03:00 CEST.
            expect(findNextCronTime("30 2 * * *", at("2026-03-29T00:00:00Z"), BERLIN)).toBe(at("2026-03-29T01:30:00Z"));
        });

        it("fires once on the gap day and returns to the normal hour the day after", () => {
            const gapRun = findNextCronTime("30 2 * * *", at("2026-03-08T00:00:00Z"), NEW_YORK)!;

            expect(findNextCronTime("30 2 * * *", gapRun, NEW_YORK)).toBe(at("2026-03-09T06:30:00Z"));
        });

        it("keeps the local hour across the change for a time outside the gap", () => {
            expect(findNextCronTime("0 9 * * *", at("2026-03-07T15:00:00Z"), NEW_YORK)).toBe(at("2026-03-08T13:00:00Z"));
            expect(findNextCronTime("0 9 * * *", at("2026-03-08T13:00:00Z"), NEW_YORK)).toBe(at("2026-03-09T13:00:00Z"));
        });
    });

    describe("fall back", () => {
        it("runs an ambiguous time once, at its earlier occurrence, in a zone behind UTC", () => {
            // 2026-11-01 01:30 happens twice in New York: 05:30Z (EDT) and 06:30Z (EST).
            const first = findNextCronTime("30 1 * * *", at("2026-11-01T00:00:00Z"), NEW_YORK)!;

            expect(first).toBe(at("2026-11-01T05:30:00Z"));
            // The repeat hour does not fire again: the next run is the following day.
            expect(findNextCronTime("30 1 * * *", first, NEW_YORK)).toBe(at("2026-11-02T06:30:00Z"));
        });

        it("runs an ambiguous time once, at its earlier occurrence, in a zone ahead of UTC", () => {
            // 2026-10-25 02:30 happens twice in Berlin: 00:30Z (CEST) and 01:30Z (CET).
            const first = findNextCronTime("30 2 * * *", at("2026-10-25T00:00:00Z"), BERLIN)!;

            expect(first).toBe(at("2026-10-25T00:30:00Z"));
            expect(findNextCronTime("30 2 * * *", first, BERLIN)).toBe(at("2026-10-26T01:30:00Z"));
        });
    });

    describe("missing or unusable zones", () => {
        const REF = at("2026-03-12T10:30:00Z");
        const utc = findNextCronTime("0 9 * * *", REF);

        it("reads an invalid zone as UTC", () => {
            expect(findNextCronTime("0 9 * * *", REF, "Not/AZone")).toBe(utc);
            expect(utc).toBe(at("2026-03-13T09:00:00Z"));
        });

        it("reads a missing, null or empty zone as UTC", () => {
            expect(findNextCronTime("0 9 * * *", REF, undefined)).toBe(utc);
            expect(findNextCronTime("0 9 * * *", REF, null)).toBe(utc);
            expect(findNextCronTime("0 9 * * *", REF, "")).toBe(utc);
        });

        it("treats an explicit UTC zone like none", () => {
            expect(findNextCronTime("0 9 * * *", REF, "UTC")).toBe(utc);
            expect(findNextCronTime("0 9 * * *", REF, "Etc/UTC")).toBe(utc);
        });
    });

    it("still finds a schedule that never fires, and a leap day, in a zone", () => {
        expect(findNextCronTime("0 0 30 2 *", at("2026-03-12T00:00:00Z"), NEW_YORK)).toBeUndefined();
        expect(findNextCronTime("0 0 29 2 *", at("2026-03-12T00:00:00Z"), NEW_YORK)).toBe(at("2028-02-29T05:00:00Z"));
    });
});

describe("dueScheduleStep with a zone", () => {
    it("arms the next run in the trigger's zone", () => {
        const now = Date.parse("2026-07-01T00:00:00Z");

        expect(dueScheduleStep("0 9 * * *", now, "America/New_York")).toEqual({ kind: "run", nextTime: Date.parse("2026-07-01T13:00:00Z") });
        expect(dueScheduleStep("0 9 * * *", now, "Not/AZone")).toEqual({ kind: "run", nextTime: Date.parse("2026-07-01T09:00:00Z") });
    });
});

describe(cronZoneOf, () => {
    it("reads a schedule in UTC unless it is marked as zone-aware, whatever zone string it stores", () => {
        expect(cronZoneOf({ timezone: "America/New_York" })).toBeUndefined();
        expect(cronZoneOf({ cronInZone: false, timezone: "America/New_York" })).toBeUndefined();
        expect(cronZoneOf({ cronInZone: true, timezone: "America/New_York" })).toBe("America/New_York");
    });

    it("computes the next run in UTC for a stored zone that is not marked", () => {
        const now = Date.parse("2026-07-01T00:00:00Z");

        expect(dueScheduleStep("0 9 * * *", now, cronZoneOf({ timezone: "America/New_York" }))).toEqual({
            kind: "run",
            nextTime: Date.parse("2026-07-01T09:00:00Z"),
        });
    });
});
