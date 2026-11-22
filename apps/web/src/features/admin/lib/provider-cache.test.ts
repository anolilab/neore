import { describe, expect, it } from "vitest";

import { byDay, cachedShare, resolveTimeZone, sumCounts } from "./provider-cache";

const hour = (iso: string, promptTokens: number, cachedTokens: number) => {
    return { cachedTokens, hour: iso, promptTokens, requests: 1 };
};

describe("provider cache rollups", () => {
    const hours = [hour("2026-11-20T23:00:00.000Z", 100, 50), hour("2026-11-21T00:00:00.000Z", 100, 90), hour("2026-11-21T05:00:00.000Z", 300, 0)];

    it("sums hours by day in the given time zone, newest first", () => {
        expect(byDay(hours, "UTC")).toEqual([
            { cachedTokens: 90, day: "2026-11-21", promptTokens: 400, requests: 2 },
            { cachedTokens: 50, day: "2026-11-20", promptTokens: 100, requests: 1 },
        ]);
        // At UTC−08:00, midnight UTC on the 21st is still the 20th.
        expect(byDay(hours, "America/Los_Angeles")).toEqual([{ cachedTokens: 140, day: "2026-11-20", promptTokens: 500, requests: 3 }]);
    });

    it("uses the configured time zone only when Intl knows it", () => {
        expect(resolveTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
        expect(resolveTimeZone("Not/AZone")).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
        expect(resolveTimeZone(undefined)).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
    });

    it("gives the cached share, and none when nothing was sent", () => {
        expect(cachedShare({ cachedTokens: 30, promptTokens: 120, requests: 2 })).toBe(0.25);
        expect(cachedShare({ cachedTokens: 0, promptTokens: 0, requests: 0 })).toBeNull();
        expect(sumCounts([])).toEqual({ cachedTokens: 0, promptTokens: 0, requests: 0 });
    });
});
