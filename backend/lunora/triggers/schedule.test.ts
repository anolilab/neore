import { describe, expect, it } from "vitest";

import { getNextCronTime, isValidCronExpression } from "./schedule";

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

    it("should fallback for months beyond 31-day search window", () => {
        // "0 0 1 12 *" — December is ~9 months away, beyond 31-day window
        const next = getNextCronTime("0 0 1 12 *", REF);

        expect(next).toBe(REF + 3_600_000); // fallback: 1 hour from now
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
