import { describe, expect, it } from "vitest";

import { formatReportedCost } from "./reported-cost";

describe("formatReportedCost", () => {
    it("keeps two significant digits below a cent, so a small cumulative cost is not shown as zero", () => {
        expect(formatReportedCost({ amount: 0.0043, currency: "USD" }, "en-US")).toBe("$0.0043");
    });

    it("uses the currency's own digits at a cent and above", () => {
        expect(formatReportedCost({ amount: 0.5, currency: "USD" }, "en-US")).toBe("$0.50");
        expect(formatReportedCost({ amount: 12.3456, currency: "USD" }, "en-US")).toBe("$12.35");
    });

    it("formats in the locale it is given, not the browser's", () => {
        expect(formatReportedCost({ amount: 12.5, currency: "EUR" }, "de-DE")).toContain("12,50");
    });

    it("falls back to the bare number, in the locale, and the code for a currency the platform does not know", () => {
        expect(formatReportedCost({ amount: 0.5, currency: "not money!" }, "en-US")).toBe("0.5 not money!");
        expect(formatReportedCost({ amount: 0.5, currency: "not money!" }, "de-DE")).toBe("0,5 not money!");
    });
});
