import { describe, expect, it } from "vitest";

import { formatClock, parseSchedule } from "./schedule-text";

describe("parseSchedule", () => {
    it.each([
        ["30 * * * *", { kind: "hourly", minute: 30 }],
        ["5 8 * * *", { hour: 8, kind: "daily", minute: 5 }],
        ["0 9 * * 1-5", { hour: 9, kind: "weekdays", minute: 0 }],
        ["15 18 * * 1", { hour: 18, kind: "weekly", minute: 15, weekday: 1 }],
        ["0 7 * * 7", { hour: 7, kind: "weekly", minute: 0, weekday: 0 }],
        ["0 10 1 * *", { hour: 10, kind: "monthly", minute: 0, monthDay: 1 }],
    ])("reads %s", (cron, parts) => {
        expect(parseSchedule(cron)).toEqual(parts);
    });

    it.each(["", "* * * * *", "*/15 * * * *", "0,30 9 * * *", "0 9 * 6 *", "0 9 1 * 1", "0 24 * * *", "60 9 * * *", "0 9 * * 8", "0 9 0 * *", "0 9 * *"])(
        "leaves %j to be shown as written",
        (cron) => {
            expect(parseSchedule(cron)).toBeNull();
        },
    );
});

describe("formatClock", () => {
    it("pads the hour and the minute", () => {
        expect(formatClock(7, 5)).toBe("07:05");
    });
});
