import { describe, expect, it } from "vitest";

import { displayStatus, lastSyncedLabel } from "./labels";

const LAST_SEEN = /^Last seen/;

describe("displayStatus", () => {
    it("never shows a cached running session as running", () => {
        for (const status of ["running", "busy", "starting", "streaming", "queued", "pending"]) {
            expect(displayStatus(status, { isOffline: true, lastSeenAt: undefined }), status).toMatch(LAST_SEEN);
            expect(displayStatus(status, { isOffline: true, lastSeenAt: undefined }).toLowerCase(), status).not.toContain("running");
        }
    });

    it("says running only for live data", () => {
        expect(displayStatus("running", { isOffline: false, lastSeenAt: undefined })).toBe("Running");
        expect(displayStatus("busy", { isOffline: false, lastSeenAt: undefined })).toBe("Running");
    });

    it("leaves a settled status as it was", () => {
        expect(displayStatus("finish", { isOffline: true, lastSeenAt: undefined })).toBe("Finished");
    });

    it("shows a host that stopped answering as last seen, online or not", () => {
        expect(displayStatus("offline", { isOffline: false, lastSeenAt: undefined })).toBe("Last seen");
        expect(displayStatus("ended", { isOffline: true, lastSeenAt: undefined })).toBe("Ended");
    });

    it("names the time a cached running session was last seen", () => {
        const label = displayStatus("running", {
            isOffline: true,
            lastSeenAt: Date.UTC(2026, 9, 31, 12, 0),
            locale: "en-US",
            now: Date.UTC(2026, 10, 5),
            timeZone: "UTC",
        });

        expect(label).toBe("Last seen Oct 31, 12:00 PM");
    });
});

describe("lastSyncedLabel", () => {
    it("shows the time alone for today and adds the date for an earlier day", () => {
        const now = Date.UTC(2026, 9, 31, 15, 0);

        expect(lastSyncedLabel(Date.UTC(2026, 9, 31, 12, 5), { locale: "en-US", now, timeZone: "UTC" })).toBe("Last synced 12:05 PM");
        expect(lastSyncedLabel(Date.UTC(2026, 9, 30, 12, 5), { locale: "en-US", now, timeZone: "UTC" })).toBe("Last synced Oct 30, 12:05 PM");
    });

    it("says never synced when nothing is cached", () => {
        expect(lastSyncedLabel(undefined, { now: 0 })).toBe("Not synced yet");
    });
});
