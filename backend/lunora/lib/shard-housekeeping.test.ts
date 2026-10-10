import { describe, expect, it } from "vitest";

import { HOUSEKEEPING_HORIZON_MS, HOUSEKEEPING_IDLE_INTERVAL_MS, needsHousekeeping } from "./shard-housekeeping";

const NOW = 10_000_000_000;

describe("needsHousekeeping", () => {
    it("sweeps a shard never swept", () => {
        expect(needsHousekeeping({ lastActiveAt: NOW - 1000 }, NOW)).toBe(true);
    });

    it("sweeps a shard active since its last sweep", () => {
        expect(needsHousekeeping({ housekeptAt: NOW - 60_000, lastActiveAt: NOW - 1000 }, NOW)).toBe(true);
    });

    it("skips an idle shard swept recently, and sweeps it again after a day", () => {
        expect(needsHousekeeping({ housekeptAt: NOW - 60_000, lastActiveAt: NOW - 120_000 }, NOW)).toBe(false);
        expect(needsHousekeeping({ housekeptAt: NOW - HOUSEKEEPING_IDLE_INTERVAL_MS, lastActiveAt: NOW - 2 * HOUSEKEEPING_IDLE_INTERVAL_MS }, NOW)).toBe(true);
    });

    it("drops a shard idle past the horizon", () => {
        expect(needsHousekeeping({ lastActiveAt: NOW - HOUSEKEEPING_HORIZON_MS - 1 }, NOW)).toBe(false);
    });
});
