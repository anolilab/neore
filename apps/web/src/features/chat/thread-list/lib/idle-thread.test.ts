import { describe, expect, it } from "vitest";

import type { BranchNode } from "../types";
import { isIdleThread, partitionDerivedSections } from "./derived-sections";

const NOW = 1_000_000;

const finished = (extra: Partial<BranchNode> = {}): BranchNode => {
    return {
        branchPoint: 0,
        branchType: "branch",
        children: [],
        createdAt: 1,
        depth: 0,
        lastReplyAt: 500,
        scheduled: false,
        status: "active",
        threadId: "t",
        title: "t",
        ...extra,
    };
};

describe("isIdleThread", () => {
    it("marks a finished thread with nothing pending as Idle", () => {
        expect(isIdleThread(finished(), NOW)).toBe(true);
    });

    it("keeps a pinned finished thread Idle, since a pin only places it in the ordinary groups", () => {
        expect(isIdleThread(finished({ isPinned: true }), NOW)).toBe(true);
    });

    it("does not mark a thread waiting for an approval, which moves it to Needs you", () => {
        const thread = finished({ awaitingInput: "approval" });

        expect(isIdleThread(thread, NOW)).toBe(false);
        expect(partitionDerivedSections([thread], NOW).needsYou.map((item) => item.threadId)).toEqual(["t"]);
    });

    it("does not mark a thread waiting for a question or a secret card", () => {
        expect(isIdleThread(finished({ awaitingInput: "question" }), NOW)).toBe(false);
    });

    it("does not mark a thread with a bound schedule, which can run again on its own", () => {
        expect(isIdleThread(finished({ scheduled: true }), NOW)).toBe(false);
    });

    it("does not mark a thread whose run is going", () => {
        expect(isIdleThread(finished({ status: "running" }), NOW)).toBe(false);
    });

    it("does not mark a thread whose last turn failed, which the row shows as failed", () => {
        expect(isIdleThread(finished({ status: "error" }), NOW)).toBe(false);
    });

    it("does not mark a thread that never got a reply", () => {
        expect(isIdleThread(finished({ lastReplyAt: undefined }), NOW)).toBe(false);
    });

    it("does not mark a thread whose schedule the list does not report, since an absent flag is not evidence", () => {
        expect(isIdleThread(finished({ scheduled: undefined }), NOW)).toBe(false);
    });

    it("does not mark a thread whose newest person message has no reply yet, such as an interrupted turn", () => {
        expect(isIdleThread(finished({ lastReplyAt: 500, lastUserMessageAt: 600 }), NOW)).toBe(false);
    });

    it("marks a thread whose reply came after the newest person message", () => {
        expect(isIdleThread(finished({ lastReplyAt: 500, lastUserMessageAt: 400 }), NOW)).toBe(true);
    });

    it("does not mark a thread that is snoozed, and marks it again once the snooze has ended", () => {
        expect(isIdleThread(finished({ snoozedUntil: NOW + 60_000 }), NOW)).toBe(false);
        expect(isIdleThread(finished({ snoozedUntil: NOW - 1 }), NOW)).toBe(true);
    });
});
