import { describe, expect, it } from "vitest";

import formatTimeAgo from "./relative-time";

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

describe(formatTimeAgo, () => {
    it("words the distance in the given locale", () => {
        expect(formatTimeAgo(NOW - 3 * DAY, "en", NOW)).toBe("3 days ago");
        expect(formatTimeAgo(NOW - 3 * DAY, "de", NOW)).toBe("vor 3 Tagen");
        expect(formatTimeAgo(NOW - 3 * DAY, "ja", NOW)).toBe("3 日前");
    });

    it("picks the largest whole unit", () => {
        expect(formatTimeAgo(NOW - 5 * MINUTE, "de", NOW)).toBe("vor 5 Minuten");
        expect(formatTimeAgo(NOW - 2 * 60 * MINUTE, "ja", NOW)).toBe("2 時間前");
        expect(formatTimeAgo(NOW - 14 * DAY, "en", NOW)).toBe("2 weeks ago");
        expect(formatTimeAgo(NOW - 400 * DAY, "de", NOW)).toBe("letztes Jahr");
    });

    it("says now under a minute, and accepts a Date", () => {
        expect(formatTimeAgo(new Date(NOW - 10_000), "en", NOW)).toBe("now");
        expect(formatTimeAgo(NOW, "de", NOW)).toBe("jetzt");
    });
});
