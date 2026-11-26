import { describe, expect, it } from "vitest";

import { describeElapsed } from "./elapsed";

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("describeElapsed", () => {
    it.each([
        [0, { kind: "now" }],
        [30_000, { kind: "now" }],
        [-5 * MINUTE, { kind: "now" }],
        [5 * MINUTE, { kind: "minute", value: 5 }],
        [59 * MINUTE, { kind: "minute", value: 59 }],
        [2 * HOUR, { kind: "hour", value: 2 }],
        [23 * HOUR, { kind: "hour", value: 23 }],
        [3 * DAY, { kind: "day", value: 3 }],
        [6 * DAY, { kind: "day", value: 6 }],
    ])("words %i ms ago as %j", (ago, expected) => {
        expect(describeElapsed(NOW - ago, NOW)).toEqual(expected);
    });

    it("gives a date from a week on, carrying the timestamp", () => {
        expect(describeElapsed(NOW - 7 * DAY, NOW)).toEqual({ kind: "date", value: NOW - 7 * DAY });
    });
});
