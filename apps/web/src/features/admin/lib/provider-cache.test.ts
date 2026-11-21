import { describe, expect, it } from "vitest";

import { byDay, cachedShare, sumCounts } from "./provider-cache";

const hour = (iso: string, promptTokens: number, cachedTokens: number) => {
    return { cachedTokens, hour: iso, promptTokens, requests: 1 };
};

describe("provider cache rollups", () => {
    it("sums hours by UTC day, newest first", () => {
        expect(byDay([hour("2026-11-20T23:00:00.000Z", 100, 50), hour("2026-11-21T00:00:00.000Z", 100, 90), hour("2026-11-21T05:00:00.000Z", 300, 0)])).toEqual(
            [
                { cachedTokens: 90, day: "2026-11-21", promptTokens: 400, requests: 2 },
                { cachedTokens: 50, day: "2026-11-20", promptTokens: 100, requests: 1 },
            ],
        );
    });

    it("gives the cached share, and none when nothing was sent", () => {
        expect(cachedShare({ cachedTokens: 30, promptTokens: 120, requests: 2 })).toBe(0.25);
        expect(cachedShare({ cachedTokens: 0, promptTokens: 0, requests: 0 })).toBeNull();
        expect(sumCounts([])).toEqual({ cachedTokens: 0, promptTokens: 0, requests: 0 });
    });
});
