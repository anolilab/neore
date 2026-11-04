import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { customSnoozeCheck, customSnoozeUntil, hasUnreadReply, hasUnseenReply, isSnoozed, snoozeUntil } from "./thread-state-rules";

const idle = { isOpen: false, isStreaming: false };

describe("hasUnreadReply", () => {
    it("is unread when a reply is newer than the last view, or nothing was ever viewed", () => {
        expect(hasUnreadReply({ lastReplyAt: 10, lastViewedAt: 5 }, idle)).toBe(true);
        expect(hasUnreadReply({ lastReplyAt: 10 }, idle)).toBe(true);
    });

    it("is read when the view is as new as the reply, or there is no reply", () => {
        expect(hasUnreadReply({ lastReplyAt: 10, lastViewedAt: 10 }, idle)).toBe(false);
        expect(hasUnreadReply({ lastViewedAt: 10 }, idle)).toBe(false);
        expect(hasUnreadReply({}, idle)).toBe(false);
    });

    it("is never unread while the thread is open or streaming", () => {
        expect(hasUnreadReply({ lastReplyAt: 10 }, { isOpen: true, isStreaming: false })).toBe(false);
        expect(hasUnreadReply({ lastReplyAt: 10 }, { isOpen: false, isStreaming: true })).toBe(false);
    });
});

describe("hasUnseenReply", () => {
    it("ignores the row context", () => {
        expect(hasUnseenReply({ lastReplyAt: 10, lastViewedAt: 5 })).toBe(true);
        expect(hasUnseenReply({ lastReplyAt: 10, lastViewedAt: 10 })).toBe(false);
        expect(hasUnseenReply({})).toBe(false);
    });
});

describe("isSnoozed", () => {
    it("holds only while the wake time is ahead", () => {
        expect(isSnoozed(undefined, 100)).toBe(false);
        expect(isSnoozed(100, 100)).toBe(false);
        expect(isSnoozed(101, 100)).toBe(true);
    });
});

describe("snoozeUntil", () => {
    // 2026-10-28 is a Wednesday.
    const wednesday = new Date(2026, 9, 28, 15, 30);

    it("adds an hour", () => {
        expect(snoozeUntil("hour", wednesday)).toBe(wednesday.getTime() + 3_600_000);
    });

    it("picks tomorrow 09:00 local", () => {
        expect(new Date(snoozeUntil("tomorrow", wednesday))).toEqual(new Date(2026, 9, 29, 9, 0, 0, 0));
    });

    it("picks the coming Monday 09:00 local", () => {
        expect(new Date(snoozeUntil("nextWeek", wednesday))).toEqual(new Date(2026, 10, 2, 9, 0, 0, 0));
    });

    it("moves a Monday to the following Monday, and a Sunday to the next day", () => {
        const monday = new Date(2026, 9, 26, 8, 0);
        const sunday = new Date(2026, 9, 25, 23, 0);

        const afterMonday = new Date(snoozeUntil("nextWeek", monday));
        const afterSunday = new Date(snoozeUntil("nextWeek", sunday));

        expect(afterMonday).toEqual(new Date(2026, 10, 2, 9, 0, 0, 0));
        expect(afterSunday).toEqual(new Date(2026, 9, 26, 9, 0, 0, 0));
    });
});

describe("customSnoozeUntil", () => {
    const now = new Date(2026, 10, 3, 10, 0, 0);

    it("reads a local wall-clock time that is in the future", () => {
        expect(customSnoozeUntil("2026-11-03T15:30", now)).toBe(new Date(2026, 10, 3, 15, 30).getTime());
    });

    it("refuses an empty, malformed, past or too distant value", () => {
        expect(customSnoozeUntil("", now)).toBeUndefined();
        expect(customSnoozeUntil("tomorrow", now)).toBeUndefined();
        expect(customSnoozeUntil("2026-11-03T09:00", now)).toBeUndefined();
        expect(customSnoozeUntil("2027-12-01T09:00", now)).toBeUndefined();
    });
});

describe("customSnoozeUntil across a daylight-saving change", () => {
    const zone = process.env.TZ;

    beforeEach(() => {
        process.env.TZ = "America/New_York";
    });

    afterEach(() => {
        if (zone === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = zone;
        }
    });

    it("refuses a time the clock skips, instead of waking at another time", () => {
        const now = new Date(2027, 2, 1, 12, 0, 0);

        expect(customSnoozeUntil("2027-03-14T02:30", now)).toBeUndefined();
        expect(customSnoozeUntil("2027-03-14T03:30", now)).toBe(new Date(2027, 2, 14, 3, 30).getTime());
    });

    it("names a skipped clock time as a gap, and a time out of range as a range", () => {
        const now = new Date(2027, 2, 1, 12, 0, 0);

        expect(customSnoozeCheck("2027-03-14T02:30", now)).toEqual({ problem: "gap" });
        expect(customSnoozeCheck("2027-03-01T09:00", now)).toEqual({ problem: "range" });
    });

    it("takes the first pass of a repeated hour while it is still ahead", () => {
        const now = new Date(2027, 10, 7, 0, 30, 0);

        expect(customSnoozeUntil("2027-11-07T01:30", now)).toBe(Date.UTC(2027, 10, 7, 5, 30));
    });

    it("takes the second pass of a repeated hour once the first has gone by", () => {
        const now = new Date(Date.UTC(2027, 10, 7, 5, 45));

        expect(customSnoozeUntil("2027-11-07T01:30", now)).toBe(Date.UTC(2027, 10, 7, 6, 30));
    });
});
