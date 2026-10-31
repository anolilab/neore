import { describe, expect, it } from "vitest";

import { summarize } from "./throttling";

const claim = (waitMs: number) => {
    return { claimedAt: 1_000_000 + waitMs, createdAt: 1_000_000 };
};

describe("summarize", () => {
    it("passes a fast relay with steady heartbeats", () => {
        const summary = summarize(
            Array.from({ length: 60 }, () => claim(1500)),
            Array.from({ length: 120 }, (_, index) => index * 30_000),
        );

        expect(summary).toEqual({ claimP95Ms: 1500, claims: 60, heartbeats: 120, maxHeartbeatGapMs: 30_000, passed: true });
    });

    it("fails on the 95th percentile, not on one slow claim", () => {
        const fast = Array.from({ length: 59 }, () => claim(1000));

        expect(summarize([...fast, claim(40_000)], [0, 30_000]).passed).toBe(true);
        expect(summarize([...fast, claim(40_000), claim(40_000), claim(40_000), claim(40_000)], [0, 30_000]).claimP95Ms).toBe(40_000);
        expect(summarize([...fast, claim(40_000), claim(40_000), claim(40_000), claim(40_000)], [0, 30_000]).passed).toBe(false);
    });

    it("fails on a heartbeat gap past a minute, whatever order the samples came in", () => {
        const summary = summarize([claim(500)], [0, 90_000, 30_000, 30_000]);

        expect(summary.maxHeartbeatGapMs).toBe(60_000);
        expect(summary.passed).toBe(true);
        expect(summarize([claim(500)], [0, 30_000, 100_000]).passed).toBe(false);
    });

    it("judges nothing without commands to time or heartbeats to compare", () => {
        expect(summarize([], [0, 30_000]).passed).toBeUndefined();
        expect(summarize([claim(500)], [0]).passed).toBeUndefined();
    });
});
