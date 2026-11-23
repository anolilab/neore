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
import { recordMcpEvent } from "./events-log";
import { decodeEventCursor, encodeEventCursor } from "./events-cursor";
import type { EventLogStore, StoredEvent } from "./events-poll";
import { pollEvents } from "./events-poll";

const SECRET = "test-secret";

const run = (seq: number, timestamp: number, threadId = "t1", name = RUN_COMPLETED_EVENT): StoredEvent => {
    return {
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
        oldestSeq: async () => rows[0]?.seq,
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
        const log = logOf([run(5, 500), run(6, 600), run(7, 700)]);
        const outcome = await pollEvents(log, { fromSeq: 1, maxEvents: 50, name: RUN_COMPLETED_EVENT, now: NOW });

        expect(outcome.truncated).toBe(true);
        expect(outcome.nextSeq).toBe(7);
        expect(outcome.events.map((event) => event.eventId)).toStrictEqual(["run:5", "run:6", "run:7"]);
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

    it("stops a scan that matches nothing and reports hasMore, so one poll cannot read the whole log", async () => {
        const rows = Array.from({ length: 1200 }, (_, index) => run(index + 1, 100, "other"));
        const outcome = await pollEvents(logOf(rows), { fromSeq: 0, maxEvents: 50, name: RUN_COMPLETED_EVENT, now: NOW, threadId: "t1" });

        expect(outcome).toMatchObject({ events: [], hasMore: true, nextSeq: 1000 });
    });
});

describe("the event log's recorder", () => {
    /** An in-memory `ctx.db` over `mcpEvents`, enough for `findFirst` by index fields and `insert`. */
    const memoryCtx = () => {
        const rows: (Record<string, unknown> & { seq: number })[] = [];
        const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key] === value);
        const db = {
            insert: async (_table: string, document: Record<string, unknown>) => {
                rows.push({ _id: String(rows.length), ...document } as never);
            },
            mcpEvents: {
                findFirst: async ({ orderBy, where }: { orderBy?: Record<string, "asc" | "desc">[]; where: Record<string, unknown> }) => {
                    const found = rows.filter((row) => matches(row, where));
                    const direction = orderBy?.[0]?.["seq"];

                    if (direction !== undefined) {
                        found.sort((a, b) => (direction === "asc" ? a.seq - b.seq : b.seq - a.seq));
                    }

                    return found[0];
                },
            },
        };

        return { ctx: { db, now: 777 } as never, rows };
    };

    it("numbers a user's events one past the last and writes an event once per eventId", async () => {
        const { ctx, rows } = memoryCtx();
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
    });
});
