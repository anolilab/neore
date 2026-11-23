import { describe, expect, it } from "vitest";

import { byDay, byHour, cachedShare, hourKeyIn, resolveTimeZone, sumCounts } from "./provider-cache";

const quarter = (start: string, promptTokens: number, cachedTokens: number) => {
    return { cachedTokens, promptTokens, requests: 1, start };
};

describe("provider cache rollups", () => {
    const quarters = [quarter("2026-11-20T23:00:00.000Z", 100, 50), quarter("2026-11-21T00:00:00.000Z", 100, 90), quarter("2026-11-21T05:00:00.000Z", 300, 0)];

    it("sums quarter hours by day in the given time zone, newest first", () => {
        expect(byDay(quarters, "UTC")).toEqual([
            { cachedTokens: 90, day: "2026-11-21", promptTokens: 400, requests: 2 },
            { cachedTokens: 50, day: "2026-11-20", promptTokens: 100, requests: 1 },
        ]);
        // At UTC−08:00, midnight UTC on the 21st is still the 20th.
        expect(byDay(quarters, "America/Los_Angeles")).toEqual([{ cachedTokens: 140, day: "2026-11-20", promptTokens: 500, requests: 3 }]);
    });

    it("splits a half-hour zone's days and hours at its own midnight", () => {
        // In Asia/Kolkata (UTC+05:30), 18:15Z is 23:45 on the 20th and 18:30Z is midnight on the 21st.
        const kolkata = [quarter("2026-11-20T18:15:00.000Z", 100, 10), quarter("2026-11-20T18:30:00.000Z", 200, 20)];

        expect(byDay(kolkata, "Asia/Kolkata")).toEqual([
            { cachedTokens: 20, day: "2026-11-21", promptTokens: 200, requests: 1 },
            { cachedTokens: 10, day: "2026-11-20", promptTokens: 100, requests: 1 },
        ]);
        expect(byHour(kolkata, "Asia/Kolkata")).toEqual([
            { cachedTokens: 10, promptTokens: 100, requests: 1, start: "2026-11-20T17:30:00.000Z" },
            { cachedTokens: 20, promptTokens: 200, requests: 1, start: "2026-11-20T18:30:00.000Z" },
        ]);
    });

    it("keeps the hour that repeats when clocks go back as two hours", () => {
        // Berlin leaves summer time on 2026-10-25: 00:15Z and 01:15Z are both 02:15 local.
        const fallBack = [
            quarter("2026-10-25T00:15:00.000Z", 100, 50),
            quarter("2026-10-25T00:45:00.000Z", 100, 50),
            quarter("2026-10-25T01:15:00.000Z", 100, 0),
        ];

        expect(byHour(fallBack, "Europe/Berlin")).toEqual([
            { cachedTokens: 100, promptTokens: 200, requests: 2, start: "2026-10-25T00:00:00.000Z" },
            { cachedTokens: 0, promptTokens: 100, requests: 1, start: "2026-10-25T01:00:00.000Z" },
        ]);
    });

    it("starts an hour shortened or repeated by a half-hour clock change where it really begins", () => {
        // Lord Howe moves from 01:59 (UTC+10:30) to 02:30 (UTC+11:00) on 2026-10-04: 15:30Z is 02:30, and 02:00 never happens.
        const springForward = [
            quarter("2026-10-03T15:15:00.000Z", 100, 10),
            quarter("2026-10-03T15:30:00.000Z", 100, 20),
            quarter("2026-10-03T15:45:00.000Z", 100, 30),
        ];

        expect(byHour(springForward, "Australia/Lord_Howe")).toEqual([
            { cachedTokens: 10, promptTokens: 100, requests: 1, start: "2026-10-03T14:30:00.000Z" },
            { cachedTokens: 50, promptTokens: 200, requests: 2, start: "2026-10-03T15:30:00.000Z" },
        ]);

        // On 2026-04-05, 01:30–02:00 repeats: 14:45Z is 01:45 at UTC+11:00, 15:15Z is 01:45 again at UTC+10:30.
        const fallBack = [quarter("2026-04-04T14:45:00.000Z", 100, 10), quarter("2026-04-04T15:15:00.000Z", 100, 20)];

        expect(byHour(fallBack, "Australia/Lord_Howe")).toEqual([
            { cachedTokens: 10, promptTokens: 100, requests: 1, start: "2026-04-04T14:00:00.000Z" },
            { cachedTokens: 20, promptTokens: 100, requests: 1, start: "2026-04-04T15:00:00.000Z" },
        ]);
    });

    it("keys an instant by its local date, hour and offset", () => {
        expect(hourKeyIn("2026-11-21T09:45:00.000Z", "Europe/Berlin")).toBe("2026-11-21 10 GMT+01:00");
        expect(hourKeyIn("2026-11-21T10:05:00.000Z", "Europe/Berlin")).toBe("2026-11-21 11 GMT+01:00");
    });

    it("uses the configured time zone when Intl knows it, else the fallback, else UTC", () => {
        expect(resolveTimeZone("Europe/Berlin", "Asia/Tokyo")).toBe("Europe/Berlin");
        expect(resolveTimeZone("Not/AZone", "Asia/Tokyo")).toBe("Asia/Tokyo");
        expect(resolveTimeZone(undefined)).toBe("UTC");
    });

    it("gives the cached share, and none when nothing was sent", () => {
        expect(cachedShare({ cachedTokens: 30, promptTokens: 120, requests: 2 })).toBe(0.25);
        expect(cachedShare({ cachedTokens: 0, promptTokens: 0, requests: 0 })).toBeNull();
        expect(sumCounts([])).toEqual({ cachedTokens: 0, promptTokens: 0, requests: 0 });
    });
});
