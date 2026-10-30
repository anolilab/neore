import { describe, expect, it } from "vitest";

import { activeGrants, grantExpiry, grantExpiryFor, isGrantableKey } from "./tool-permission-grants";

describe("grantExpiry", () => {
    it("lapses an hour after the grant", () => {
        const now = Date.UTC(2026, 9, 30, 12, 0, 0);

        expect(grantExpiry("hour", now, "Europe/Berlin")).toBe(now + 3_600_000);
    });

    it("ends today at the user's next local midnight", () => {
        // 23:30 UTC on 30 Oct is 00:30 on 31 Oct in Berlin (CET, UTC+1 after the 25 Oct change): the 31st ends at 23:00Z on the 31st.
        expect(grantExpiry("today", Date.UTC(2026, 9, 30, 23, 30), "Europe/Berlin")).toBe(Date.UTC(2026, 10, 1, 0, 0) - 3_600_000);
        // 12:00 UTC in New York (EDT before 1 Nov, UTC-4) ends at 04:00Z the next day.
        expect(grantExpiry("today", Date.UTC(2026, 9, 30, 12, 0), "America/New_York")).toBe(Date.UTC(2026, 9, 31, 4, 0));
    });

    it("reads a missing or unknown timezone as UTC", () => {
        const now = Date.UTC(2026, 9, 30, 12, 0);

        expect(grantExpiry("today", now, undefined)).toBe(Date.UTC(2026, 9, 31, 0, 0));
        expect(grantExpiry("today", now, "Not/AZone")).toBe(Date.UTC(2026, 9, 31, 0, 0));
    });

    it("follows a DST change: the day of the fall-back lasts 25 hours", () => {
        // Berlin falls back on 25 Oct 2026 03:00 -> 02:00. Local midnight at the end of that day is 23:00Z (CET).
        const start = Date.UTC(2026, 9, 25, 0, 30); // 02:30 CEST on the 25th
        const midnight = grantExpiry("today", start, "Europe/Berlin");

        expect(midnight).toBe(Date.UTC(2026, 9, 25, 23, 0));
        expect(midnight - start).toBe(22.5 * 3_600_000);
    });
});

describe("grants in force", () => {
    it("keeps only unexpired entries", () => {
        expect(activeGrants({ a: 10, b: 20 }, 15)).toStrictEqual({ b: 20 });
        expect(activeGrants(undefined, 15)).toStrictEqual({});
    });

    it("answers the expiry only for a grantable key still in force", () => {
        expect(grantExpiryFor({ "mcp:S:t": 20 }, "mcp:S:t", 15)).toBe(20);
        expect(grantExpiryFor({ "mcp:S:t": 20 }, "mcp:S:t", 20)).toBeUndefined();
        expect(grantExpiryFor({ "device:d:fs_read": 20 }, "device:d:fs_read", 15)).toBeUndefined();
    });

    it("refuses device tools and the question tool", () => {
        expect(isGrantableKey("device:dev-1:shell_run")).toBe(false);
        expect(isGrantableKey("builtin:askUser")).toBe(false);
        expect(isGrantableKey("mcp:Files:delete")).toBe(true);
    });
});
