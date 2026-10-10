import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "./relative-time";

const NOW = Date.UTC(2026, 8, 25, 12, 0);

describe("formatRelativeTime", () => {
    it("picks the largest whole unit", () => {
        expect(formatRelativeTime(NOW - 5 * 60_000, "en", NOW)).toBe("5 minutes ago");
        expect(formatRelativeTime(NOW - 3 * 60 * 60_000, "en", NOW)).toBe("3 hours ago");
        expect(formatRelativeTime(NOW - 24 * 60 * 60_000, "en", NOW)).toBe("yesterday");
    });

    it("says now for anything under a minute, in the UI locale", () => {
        expect(formatRelativeTime(NOW - 10_000, "en", NOW)).toBe("this minute");
        expect(formatRelativeTime(NOW - 5 * 60_000, "de", NOW)).toBe("vor 5 Minuten");
    });
});
