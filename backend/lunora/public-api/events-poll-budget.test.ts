import { describe, expect, it } from "vitest";

import { pollEvents, type StoredEvent } from "./events-poll";

const NOW = 1_000_000;
const LARGE = 300 * 1024;

const large = (seq: number): StoredEvent => {
    return {
        createdAt: NOW - 100,
        data: { blob: "x".repeat(LARGE), threadId: "open" },
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

describe("a poll whose events are large", () => {
    it("cuts the answer before the event that would pass the byte budget, and the next poll starts there", async () => {
        const log = logOf([large(1), large(2), large(3)]);
        const first = await pollEvents(log, { fromSeq: 0, maxEvents: 50, name: "run.completed", now: NOW });

        expect(first.events.map((row) => row.eventId)).toStrictEqual(["run:1"]);
        expect(first.hasMore).toBe(true);
        expect(first.nextSeq).toBe(1);

        const second = await pollEvents(log, { fromSeq: first.nextSeq, maxEvents: 50, name: "run.completed", now: NOW });

        expect(second.events.map((row) => row.eventId)).toStrictEqual(["run:2"]);
    });

    it("stops reading after the read budget, even when the rows it reads do not match, and resumes from the last one read", async () => {
        const unrelated = Array.from({ length: 40 }, (_, index) => {
            return { ...large(index + 1), name: "run.failed" };
        });
        const outcome = await pollEvents(logOf(unrelated), { fromSeq: 0, maxEvents: 50, name: "run.completed", now: NOW });

        expect(outcome.events).toStrictEqual([]);
        expect(outcome.hasMore).toBe(true);
        expect(outcome.nextSeq).toBeGreaterThan(0);
        expect(outcome.nextSeq).toBeLessThan(40);
    });

    it("budgets an event as the answer serializes it, so escape-heavy payloads cut the answer sooner", async () => {
        // Each payload is 16383 bytes of JSON; the answer encodes that text again, which doubles the backslashes.
        const escaped = Array.from({ length: 20 }, (_, index) => {
            return { ...large(index + 1), data: { blob: "\\".repeat(8186), threadId: "open" } };
        });
        const outcome = await pollEvents(logOf(escaped), { fromSeq: 0, maxEvents: 50, name: "run.completed", now: NOW });

        expect(outcome.events.length).toBeLessThan(20);
        expect(outcome.hasMore).toBe(true);
    });
});
