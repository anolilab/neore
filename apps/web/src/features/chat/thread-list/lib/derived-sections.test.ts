import { describe, expect, it } from "vitest";

import type { BranchNode } from "../types";
import { nextSnoozeWake, partitionDerivedSections } from "./derived-sections";

const NOW = 1_000_000;

const node = (threadId: string, extra: Partial<BranchNode> = {}): BranchNode => {
    return { branchPoint: 0, branchType: "branch", children: [], createdAt: 1, depth: 0, status: "active", threadId, title: threadId, ...extra };
};

const ids = (threads: BranchNode[]) => threads.map((thread) => thread.threadId);

describe("partitionDerivedSections", () => {
    it("puts waiting threads in needsYou and running ones in working, newest activity first", () => {
        const result = partitionDerivedSections(
            [
                node("a", { awaitingInput: "question", lastReplyAt: 10 }),
                node("b", { awaitingInput: "approval", lastReplyAt: 20 }),
                node("c", { status: "running", updatedAt: 5 }),
                node("d", { status: "running", updatedAt: 9 }),
                node("e"),
            ],
            NOW,
        );

        expect(ids(result.needsYou)).toEqual(["b", "a"]);
        expect(ids(result.working)).toEqual(["d", "c"]);
        expect(ids(result.rest)).toEqual(["e"]);
        expect(result.snoozed).toEqual([]);
    });

    it("lets running win over waiting, since the row shows it streaming", () => {
        const result = partitionDerivedSections([node("a", { awaitingInput: "approval", status: "running" })], NOW);

        expect(ids(result.working)).toEqual(["a"]);
        expect(result.needsYou).toEqual([]);
    });

    it("keeps pinned threads out of needsYou and working", () => {
        const result = partitionDerivedSections(
            [node("a", { awaitingInput: "question", isPinned: true }), node("b", { isPinned: true, status: "running" })],
            NOW,
        );

        expect(ids(result.rest)).toEqual(["a", "b"]);
        expect(result.needsYou).toEqual([]);
        expect(result.working).toEqual([]);
    });

    it("moves a snoozed thread out of every other section, waking soonest first", () => {
        const result = partitionDerivedSections(
            [
                node("a", { awaitingInput: "question", snoozedUntil: NOW + 20 }),
                node("b", { isPinned: true, snoozedUntil: NOW + 10 }),
                node("c", { snoozedUntil: NOW + 30, status: "running" }),
            ],
            NOW,
        );

        expect(ids(result.snoozed)).toEqual(["b", "a", "c"]);
        expect(result.rest).toEqual([]);
    });

    it("treats an elapsed snooze as no snooze", () => {
        const result = partitionDerivedSections([node("a", { snoozedUntil: NOW }), node("b", { snoozedUntil: NOW - 1 })], NOW);

        expect(result.snoozed).toEqual([]);
        expect(ids(result.rest)).toEqual(["a", "b"]);
    });
});

describe("nextSnoozeWake", () => {
    it("is the earliest pending snooze", () => {
        expect(nextSnoozeWake([{ snoozedUntil: NOW + 50 }, { snoozedUntil: NOW + 5 }, { snoozedUntil: NOW - 5 }, {}], NOW)).toBe(NOW + 5);
    });

    it("is undefined when nothing is snoozed", () => {
        expect(nextSnoozeWake([{ snoozedUntil: NOW - 5 }, {}], NOW)).toBeUndefined();
    });
});
