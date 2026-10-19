import { describe, expect, it } from "vitest";

import { storedRetentionHours } from "./temporary-retention";

describe(storedRetentionHours, () => {
    it("keeps a stored value inside 1 to 168 hours", () => {
        expect(storedRetentionHours(1)).toBe(1);
        expect(storedRetentionHours(72)).toBe(72);
        expect(storedRetentionHours(168)).toBe(168);
    });

    it("falls back to a day for a missing or out-of-range value", () => {
        for (const value of [undefined, 0, -5, 169, 100_000, NaN, Infinity]) {
            expect(storedRetentionHours(value)).toBe(24);
        }
    });
});
