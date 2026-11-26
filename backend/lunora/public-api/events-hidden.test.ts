import { describe, expect, it, vi } from "vitest";

import { pollEvents, type StoredEvent } from "./events-poll";

const NOW = 1_000_000;

const event = (seq: number, threadId: string): StoredEvent => {
    return {
        createdAt: NOW - 100,
        data: { threadId },
        eventId: `run:${String(seq)}`,
        name: "run.completed",
        seq,
        timestamp: NOW - 100,
    };
};

const logOf = (events: StoredEvent[]) => {
    return {
        after: async (afterSeq: number, limit: number) => events.filter((row) => row.seq > afterSeq).slice(0, limit),
        latestSeq: async () => events.length,
        prunedThrough: async () => 0,
    };
};

describe("a poll that hides some events", () => {
    it("skips a hidden event without reporting a gap, and returns the others", async () => {
        const log = logOf([event(1, "open"), event(2, "locked"), event(3, "open")]);
        const outcome = await pollEvents(log, {
            fromSeq: 0,
            hidden: async (row) => row.data["threadId"] === "locked",
            maxEvents: 50,
            name: "run.completed",
            now: NOW,
        });

        expect(outcome.events.map((row) => row.eventId)).toStrictEqual(["run:1", "run:3"]);
        expect(outcome.truncated).toBe(false);
        expect(outcome.nextSeq).toBe(3);
    });

    it("looks up visibility only for the events the poll asked for", async () => {
        const log = logOf([event(1, "open"), event(2, "locked"), { ...event(3, "open"), name: "run.failed" }]);
        const hidden = vi.fn(async (row: StoredEvent) => row.data["threadId"] === "locked");

        await pollEvents(log, { fromSeq: 0, hidden, maxEvents: 50, name: "run.completed", now: NOW });

        expect(hidden.mock.calls.map(([row]) => row.seq)).toStrictEqual([1, 2]);
    });

    it("does not report a gap for an aged-out event on a locked thread", async () => {
        const aged: StoredEvent = { ...event(1, "locked"), createdAt: NOW - 10_000 };
        const log = logOf([aged, event(2, "open")]);
        const outcome = await pollEvents(log, {
            fromSeq: 0,
            hidden: async (row) => row.data["threadId"] === "locked",
            maxAgeMs: 1000,
            maxEvents: 50,
            name: "run.completed",
            now: NOW,
        });

        expect(outcome.events.map((row) => row.eventId)).toStrictEqual(["run:2"]);
        expect(outcome.truncated).toBe(false);
        expect(outcome.nextSeq).toBe(2);
    });
});
