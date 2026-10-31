import { describe, expect, it } from "vitest";

import { hasUnreadReply, hasUnseenReply, isSnoozed, snoozeUntil } from "./thread-state-rules";

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
