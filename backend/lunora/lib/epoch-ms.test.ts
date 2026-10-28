import { describe, expect, it } from "vitest";

import { toEpochMs } from "./epoch-ms";

describe("toEpochMs", () => {
    it("keeps a number, and reads an ISO string or a Date as epoch milliseconds", () => {
        expect(toEpochMs(1_793_197_500_535)).toBe(1_793_197_500_535);
        expect(toEpochMs("2026-10-28T14:25:00.535Z")).toBe(Date.parse("2026-10-28T14:25:00.535Z"));
        expect(toEpochMs(new Date("2026-10-28T14:25:00.535Z"))).toBe(Date.parse("2026-10-28T14:25:00.535Z"));
    });

    it("reads an unreadable value as 0", () => {
        expect(toEpochMs("not a date")).toBe(0);
        expect(toEpochMs(undefined)).toBe(0);
    });
});
