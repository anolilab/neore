import { describe, expect, it } from "vitest";

import { formatDate, formatDateTime, formatNumber, formatTime } from "./locale-format";

// 2026-10-02 14:05:09 UTC, formatted in UTC so the result does not depend on the runner's zone.
const AT = Date.UTC(2026, 9, 2, 14, 5, 9);
const UTC = { timeZone: "UTC" } as const;

describe(formatDate, () => {
    it("formats in the given locale, not the runtime's", () => {
        expect(formatDate(AT, "en-US", UTC)).toBe("10/2/2026");
        expect(formatDate(AT, "de", UTC)).toBe("2.10.2026");
        expect(formatDate(AT, "ja", UTC)).toBe("2026/10/2");
    });

    it("accepts a Date, a timestamp and an ISO string alike", () => {
        const options = { ...UTC, dateStyle: "long" } as const;

        expect(formatDate(new Date(AT), "de", options)).toBe("2. Oktober 2026");
        expect(formatDate(new Date(AT).toISOString(), "de", options)).toBe("2. Oktober 2026");
        expect(formatDate(AT, "ja", options)).toBe("2026年10月2日");
        expect(formatDate(AT, "en", options)).toBe("October 2, 2026");
    });
});

describe(formatDateTime, () => {
    it("includes the time, worded per locale", () => {
        expect(formatDateTime(AT, "en-US", UTC)).toBe("10/2/2026, 2:05:09 PM");
        expect(formatDateTime(AT, "de", UTC)).toBe("2.10.2026, 14:05:09");
        expect(formatDateTime(AT, "ja", UTC)).toBe("2026/10/2 14:05:09");
    });
});

describe(formatTime, () => {
    it("formats the time of day per locale", () => {
        expect(formatTime(AT, "en-US", UTC)).toBe("2:05:09 PM");
        expect(formatTime(AT, "de", UTC)).toBe("14:05:09");
    });
});

describe(formatNumber, () => {
    it("uses the locale's separators", () => {
        expect(formatNumber(1_234_567.891, "en")).toBe("1,234,567.891");
        expect(formatNumber(1_234_567.891, "de")).toBe("1.234.567,891");
        expect(formatNumber(1_234_567.891, "ja")).toBe("1,234,567.891");
        expect(formatNumber(1234.5, "de", { minimumFractionDigits: 2 })).toBe("1.234,50");
    });
});
