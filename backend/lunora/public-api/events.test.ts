/**
 * The Events extension's pure parts: the catalog's schemas, the cursor's binding to one user, `events/poll` over a log, and the
 * recorder that writes the log. The dispatcher's gating and error codes are in `events-mcp.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
    APPROVAL_REQUESTED_EVENT,
    describeEvents,
    EVENT_CATALOG,
    findEvent,
    parseEventArguments,
    RUN_COMPLETED_EVENT,
    RUN_FAILED_EVENT,
} from "./events-catalog";
import { copyMergedMcpEvents, recordMcpEvent } from "./events-log";
import { decodeEventCursor, encodeEventCursor } from "./events-cursor";
import type { EventLogStore, StoredEvent } from "./events-poll";
import { pollEvents } from "./events-poll";

const SECRET = "test-secret";

const run = (seq: number, timestamp: number, threadId = "t1", name = RUN_COMPLETED_EVENT, createdAt = timestamp): StoredEvent => {
    return {
        createdAt,
        data: { finishedAt: timestamp, outcome: "succeeded", threadId },
        eventId: `run:${seq}`,
        name,
        seq,
        timestamp,
    };
};

/** A store over rows already sorted by seq, the way the shard's index returns them. */
const logOf = (rows: StoredEvent[]): EventLogStore => {
    return {
        after: async (afterSeq, limit) => rows.filter((row) => row.seq > afterSeq).slice(0, limit),
        latestSeq: async () => rows.at(-1)?.seq ?? 0,
        prunedThrough: async () => 0,
    };
};

const NOW = 10_000;

describe("event catalog", () => {
    it("offers the three event types, all by poll, in a fixed order", () => {
        expect(EVENT_CATALOG.map((event) => event.name)).toStrictEqual([RUN_COMPLETED_EVENT, RUN_FAILED_EVENT, APPROVAL_REQUESTED_EVENT]);
        expect(describeEvents().every((event) => JSON.stringify(event.delivery) === '["poll"]')).toBe(true);
    });

    it("takes an optional threadId filter and nothing else", () => {
        for (const event of EVENT_CATALOG) {
            expect(event.inputSchema).toMatchObject({ additionalProperties: false, properties: { threadId: { type: "string" } } });
            expect(event.inputSchema).not.toHaveProperty("required");
        }

        expect(parseEventArguments(undefined)).toStrictEqual({});
        expect(parseEventArguments({ threadId: "t1" })).toStrictEqual({ threadId: "t1" });
        expect(parseEventArguments({ severity: "P1" })).toBeNull();
        expect(parseEventArguments({ threadId: 7 })).toBeNull();
        expect(parseEventArguments({ threadId: "" })).toBeNull();
        expect(parseEventArguments("t1")).toBeNull();
    });

    it("gives run events the {threadId, outcome, finishedAt} payload and approvals {threadId, requestId, kind}", () => {
        expect(findEvent(RUN_COMPLETED_EVENT)?.payloadSchema).toMatchObject({ required: ["threadId", "outcome", "finishedAt"] });
        expect(findEvent(RUN_FAILED_EVENT)?.payloadSchema).toMatchObject({ required: ["threadId", "outcome", "finishedAt"] });

        const approval = findEvent(APPROVAL_REQUESTED_EVENT)?.payloadSchema as { properties: { kind: { enum: string[] } }; required: string[] };

        expect(approval.required).toStrictEqual(["threadId", "requestId", "kind"]);
        expect(approval.properties.kind.enum).toStrictEqual(["approval", "question", "secret"]);
        expect(findEvent("run.started")).toBeUndefined();
    });
});

describe("event cursor", () => {
    it("round-trips the seq for the user it was given to", async () => {
        const cursor = await encodeEventCursor(SECRET, "user-a", 42);

        expect(await decodeEventCursor(SECRET, "user-a", cursor)).toBe(42);
    });

    it("is refused for another user, for an edited payload, a wrong key and a malformed string", async () => {
        const cursor = await encodeEventCursor(SECRET, "user-a", 42);
        const [payload, mac] = cursor.split(".") as [string, string];
        const edited = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${mac}`;

        expect(await decodeEventCursor(SECRET, "user-b", cursor)).toBeNull();
        expect(await decodeEventCursor(SECRET, "user-a", edited)).toBeNull();
        expect(await decodeEventCursor("other-secret", "user-a", cursor)).toBeNull();
        expect(await decodeEventCursor(SECRET, "user-a", "not-a-cursor")).toBeNull();
        expect(await decodeEventCursor(SECRET, "user-a", `${payload}.`)).toBeNull();
    });
});

describe("events/poll over a log", () => {
    it("starts from now with a null cursor: no events, the log's current end", async () => {
        const log = logOf([run(1, 100), run(2, 200)]);

        expect(await pollEvents(log, { fromSeq: null, maxEvents: 50, name: RUN_COMPLETED_EVENT, now: NOW })).toStrictEqual({
            events: [],
            hasMore: false,
            nextSeq: 2,
            truncated: false,
        });
    });

    it("returns the events after the cursor, in order, and resumes from the last one", async () => {
        const log = logOf([run(1, 100), run(2, 200), run(3, 300)]);
        const first = await pollEvents(log, { fromSeq: 1, maxEvents: 50, name: RUN_COMPLETED_EVENT, now: NOW });

        expect(first.events.map((event) => event.eventId)).toStrictEqual(["run:2", "run:3"]);
        expect(first).toMatchObject({ hasMore: false, nextSeq: 3, truncated: false });

        expect(await pollEvents(log, { fromSeq: 3, maxEvents: 50, name: RUN_COMPLETED_EVENT, now: NOW })).toMatchObject({ events: [], nextSeq: 3 });
    });

    it("reports truncated and resumes from the oldest kept position when the cursor is older than the window", async () => {
        // Seqs 1 to 4 were pruned by retention; the cursor still names seq 1.
        const log = { ...logOf([run(5, 500), run(6, 600), run(7, 700)]), prunedThrough: async () => 4 };
        const outcome = await pollEvents(log, { fromSeq: 1, maxEvents: 50, name: RUN_COMPLETED_EVENT, now: NOW });

        expect(outcome.truncated).toBe(true);
        expect(outcome.nextSeq).toBe(7);
        expect(outcome.events.map((event) => event.eventId)).toStrictEqual(["run:5", "run:6", "run:7"]);
    });

    it("refuses a poll that may return no events, since its cursor could never move past the first match", async () => {
        const log = logOf([run(1, 100)]);

        await expect(pollEvents(log, { fromSeq: 0, maxEvents: 0, name: RUN_COMPLETED_EVENT, now: NOW })).rejects.toThrow("at least 1");
    });

    it.each([-1, NaN, Infinity])("refuses a window of %s ms, which would read every event as older than the floor", async (maxAgeMs) => {
        const log = logOf([run(1, 100)]);

        await expect(pollEvents(log, { fromSeq: 0, maxAgeMs, maxEvents: 50, name: RUN_COMPLETED_EVENT, now: NOW })).rejects.toThrow("maxAgeMs");
    });

    it("caps a batch at maxEvents, keeps the cursor before the first event not sent, and says hasMore", async () => {
        const log = logOf([run(1, 100), run(2, 200), run(3, 300), run(4, 400), run(5, 500)]);

        const first = await pollEvents(log, { fromSeq: 0, maxEvents: 2, name: RUN_COMPLETED_EVENT, now: NOW });

        expect(first).toMatchObject({ hasMore: true, nextSeq: 2, truncated: false });
        expect(first.events).toHaveLength(2);

        const second = await pollEvents(log, { fromSeq: first.nextSeq, maxEvents: 2, name: RUN_COMPLETED_EVENT, now: NOW });

        expect(second.events.map((event) => event.eventId)).toStrictEqual(["run:3", "run:4"]);
        expect(second.hasMore).toBe(true);

        const last = await pollEvents(log, { fromSeq: second.nextSeq, maxEvents: 2, name: RUN_COMPLETED_EVENT, now: NOW });

        expect(last).toMatchObject({ hasMore: false, nextSeq: 5 });
    });

    it("answers only the event name asked for and the threadId filter when one is given", async () => {
        const log = logOf([run(1, 100, "t1"), run(2, 200, "t2", RUN_FAILED_EVENT), run(3, 300, "t2"), run(4, 400, "t1")]);

        const byThread = await pollEvents(log, { fromSeq: 0, maxEvents: 50, name: RUN_COMPLETED_EVENT, now: NOW, threadId: "t2" });

        expect(byThread.events.map((event) => event.eventId)).toStrictEqual(["run:3"]);
        expect(byThread.nextSeq).toBe(4);

        const failed = await pollEvents(log, { fromSeq: 0, maxEvents: 50, name: RUN_FAILED_EVENT, now: NOW });

        expect(failed.events.map((event) => event.eventId)).toStrictEqual(["run:2"]);
    });

    it("skips events older than maxAgeMs and reports the gap as truncated", async () => {
        const log = logOf([run(1, 5000), run(2, 9500)]);
        const outcome = await pollEvents(log, { fromSeq: 0, maxAgeMs: 1000, maxEvents: 50, name: RUN_COMPLETED_EVENT, now: NOW });

        expect(outcome.events.map((event) => event.eventId)).toStrictEqual(["run:2"]);
        expect(outcome.truncated).toBe(true);
        expect(outcome.nextSeq).toBe(2);
    });

    it("keeps an event recorded late for the window from when the log took it, though it happened long before", async () => {
        // Happened 10 s before `now` (old by its upstream time), but recorded at `now`: the log keeps it, so the poll returns it.
        const log = logOf([run(1, 1000, "t1", RUN_COMPLETED_EVENT, NOW - 100)]);
        const outcome = await pollEvents(log, { fromSeq: 0, maxAgeMs: 1000, maxEvents: 50, name: RUN_COMPLETED_EVENT, now: NOW });

        expect(outcome.events.map((event) => event.eventId)).toStrictEqual(["run:1"]);
        expect(outcome.events[0]?.timestamp).toBe(1000);
        expect(outcome.truncated).toBe(false);
    });

    it("does not report a gap for an old event of another name or thread, which the caller never asked for", async () => {
        const log = logOf([run(1, 5000, "t1", RUN_FAILED_EVENT), run(2, 5100, "t2"), run(3, 9500)]);
        const outcome = await pollEvents(log, { fromSeq: 0, maxAgeMs: 1000, maxEvents: 50, name: RUN_COMPLETED_EVENT, now: NOW, threadId: "t1" });

        expect(outcome.events.map((event) => event.eventId)).toStrictEqual(["run:3"]);
        expect(outcome.truncated).toBe(false);
        expect(outcome.nextSeq).toBe(3);
    });

    it("stops a scan that matches nothing and reports hasMore, so one poll cannot read the whole log", async () => {
        const rows = Array.from({ length: 1200 }, (_, index) => run(index + 1, 100, "other"));
        const outcome = await pollEvents(logOf(rows), { fromSeq: 0, maxEvents: 50, name: RUN_COMPLETED_EVENT, now: NOW, threadId: "t1" });

        expect(outcome).toMatchObject({ events: [], hasMore: true, nextSeq: 1000 });
    });
});

describe("the event log's recorder", () => {
    /** An in-memory `ctx.db` over `mcpEvents` and `mcpEventWatermarks`, enough for `findFirst` by index fields, `insert` and `patch`. */
    const memoryCtx = () => {
        const rows: (Record<string, unknown> & { seq: number })[] = [];
        const watermarks: (Record<string, unknown> & { seq: number })[] = [];
        const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key] === value);
        const findFirst =
            (list: (Record<string, unknown> & { seq: number })[]) =>
            async ({ orderBy, where }: { orderBy?: Record<string, "asc" | "desc">[]; where: Record<string, unknown> }) => {
                const found = list.filter((row) => matches(row, where));
                const direction = orderBy?.[0]?.["seq"];

                if (direction !== undefined) {
                    found.sort((a, b) => (direction === "asc" ? a.seq - b.seq : b.seq - a.seq));
                }

                return found[0];
            };
        const db = {
            insert: async (table: string, document: Record<string, unknown>) => {
                const list = table === "mcpEvents" ? rows : watermarks;

                list.push({ _id: String(list.length), ...document } as never);
            },
            mcpEvents: { findFirst: findFirst(rows) },
            mcpEventWatermarks: { findFirst: findFirst(watermarks) },
            patch: async (_table: string, id: string, fields: Record<string, unknown>) => {
                Object.assign(watermarks.find((row) => row["_id"] === id) ?? {}, fields);
            },
        };

        return { ctx: { db, now: 777 } as never, rows, watermarks };
    };

    it("numbers a user's events one past the last and writes an event once per eventId", async () => {
        const { ctx, rows, watermarks } = memoryCtx();
        const input = {
            data: { kind: "approval", requestId: "a1", threadId: "t1" },
            eventId: "approval:a1",
            name: APPROVAL_REQUESTED_EVENT,
            timestamp: 5,
            userId: "user-a",
        };

        expect(await recordMcpEvent(ctx, input)).toBe(true);
        expect(await recordMcpEvent(ctx, input)).toBe(false);
        expect(await recordMcpEvent(ctx, { ...input, eventId: "run:s1", name: RUN_COMPLETED_EVENT, userId: "user-a" })).toBe(true);
        expect(await recordMcpEvent(ctx, { ...input, eventId: "approval:a2", userId: "user-b" })).toBe(true);

        expect(rows.map((row) => [row["userId"], row["seq"], row["eventId"], row["createdAt"]])).toStrictEqual([
            ["user-a", 1, "approval:a1", 777],
            ["user-a", 2, "run:s1", 777],
            ["user-b", 1, "approval:a2", 777],
        ]);
        expect(JSON.parse(rows[0]?.["data"] as string)).toStrictEqual({ kind: "approval", requestId: "a1", threadId: "t1" });
        expect(watermarks.map((row) => [row["userId"], row["seq"]])).toStrictEqual([
            ["user-a", 2],
            ["user-b", 1],
        ]);
    });

    it("keeps the sequence when the rows are gone: the next event follows the watermark, not the rows", async () => {
        const { ctx, rows } = memoryCtx();
        const input = { data: {}, eventId: "run:s1", name: RUN_COMPLETED_EVENT, timestamp: 5, userId: "user-a" };

        await recordMcpEvent(ctx, input);
        rows.length = 0;

        expect(await recordMcpEvent(ctx, { ...input, eventId: "run:s2" })).toBe(true);
        expect(rows.map((row) => row["seq"])).toStrictEqual([2]);
    });

    it("appends a merged guest's events after the new account's sequence, once per eventId", async () => {
        const { ctx, rows, watermarks } = memoryCtx();

        await recordMcpEvent(ctx, { data: {}, eventId: "run:own1", name: RUN_COMPLETED_EVENT, timestamp: 1, userId: "user" });
        await recordMcpEvent(ctx, { data: {}, eventId: "run:own2", name: RUN_COMPLETED_EVENT, timestamp: 2, userId: "user" });

        // The guest's own numbering (1, 2) collides with the new account's; the merge must not keep it.
        const guest = [
            { createdAt: 10, data: "{}", eventId: "run:g2", name: RUN_COMPLETED_EVENT, seq: 2, timestamp: 4, userId: "guest" },
            { createdAt: 9, data: "{}", eventId: "run:g1", name: RUN_COMPLETED_EVENT, seq: 1, timestamp: 3, userId: "guest" },
        ];

        expect(await copyMergedMcpEvents(ctx, guest, "user")).toBe(2);
        // A page imported again (a redelivery) writes nothing more.
        expect(await copyMergedMcpEvents(ctx, guest, "user")).toBe(0);

        expect(rows.filter((row) => row["userId"] === "user").map((row) => [row["eventId"], row["seq"], row["createdAt"]])).toStrictEqual([
            ["run:own1", 1, 777],
            ["run:own2", 2, 777],
            ["run:g1", 3, 777],
            ["run:g2", 4, 777],
        ]);
        expect(watermarks.find((row) => row["userId"] === "user")?.["seq"]).toBe(4);
    });
});

describe("events/poll over a log whose rows are all gone", () => {
    it("reports no gap for a cursor behind rows a chat's removal took out, since retention expired none of them", async () => {
        const store: EventLogStore = { after: async () => [], latestSeq: async () => 10, prunedThrough: async () => 0 };

        expect(await pollEvents(store, { fromSeq: 4, maxEvents: 10, name: RUN_COMPLETED_EVENT, now: NOW })).toStrictEqual({
            events: [],
            hasMore: false,
            nextSeq: 4,
            truncated: false,
        });
    });

    it("does not report a gap when a chat's removal took out the oldest rows, so a poll from zero reads on from the first kept one", async () => {
        // Seqs 1 and 2 belonged to a chat the user deleted: their rows are gone, but retention expired none of them.
        const log = { ...logOf([run(3, 300), run(4, 400), run(5, 500)]), prunedThrough: async () => 0 };
        const outcome = await pollEvents(log, { fromSeq: 0, maxEvents: 50, name: RUN_COMPLETED_EVENT, now: NOW });

        expect(outcome.truncated).toBe(false);
        expect(outcome.events.map((event) => event.eventId)).toStrictEqual(["run:3", "run:4", "run:5"]);
    });

    it("reports truncated and resumes at the retention position when the cursor is behind it", async () => {
        const store: EventLogStore = { after: async () => [], latestSeq: async () => 10, prunedThrough: async () => 8 };

        expect(await pollEvents(store, { fromSeq: 4, maxEvents: 10, name: RUN_COMPLETED_EVENT, now: NOW })).toStrictEqual({
            events: [],
            hasMore: false,
            nextSeq: 8,
            truncated: true,
        });
    });

    it("is not truncated for a cursor already at the log's end", async () => {
        const store: EventLogStore = { after: async () => [], latestSeq: async () => 10, prunedThrough: async () => 0 };

        expect(await pollEvents(store, { fromSeq: 10, maxEvents: 10, name: RUN_COMPLETED_EVENT, now: NOW })).toStrictEqual({
            events: [],
            hasMore: false,
            nextSeq: 10,
            truncated: false,
        });
    });
});
