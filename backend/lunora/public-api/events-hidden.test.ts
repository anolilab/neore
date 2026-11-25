import { describe, expect, it } from "vitest";

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
        oldestSeq: async () => events[0]?.seq,
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
});
