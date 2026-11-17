/**
 * The shard footprint scan: the 10,000-row thread is the largest, a call reads at most one page,
 * the largest list stays capped at {@link LARGEST_THREAD_COUNT}, a call stays within its shard-call
 * budget, and an unfinished shard resumes from its carried state.
 */
import { lunoraTest } from "@lunora/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { decodeCensusCursor, encodeCensusCursor, measureShardPage } from "./cleanup";
import {
    addMessageRow,
    type CensusCursor,
    FOOTPRINT_PAGE_SIZE,
    forCursor,
    LARGEST_THREAD_COUNT,
    MAX_SHARD_CALLS_PER_ACTION,
    rootOnlyCensus,
    runScanRounds,
    type ScanEntry,
    startCensus,
    startFootprint,
    withRootShard,
} from "./shard-footprint-logic";

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "user-owner";
const BIG_THREAD_ROWS = 10_000;
const SMALL_THREAD_COUNT = 30;
const SMALL_THREAD_ROWS = 3;

/** Row counts of the small threads: {@link SMALL_THREAD_COUNT} threads of {@link SMALL_THREAD_ROWS} rows each. */
const smallThreadRows = (): number[] => {
    const rows: number[] = [];

    for (let index = 0; index < SMALL_THREAD_COUNT; index += 1) {
        rows.push(SMALL_THREAD_ROWS);
    }

    return rows;
};

/** Seeds one thread per entry of `rowsPerThread` and returns the thread ids in that order. */
const seedShard = (harness: Harness, rowsPerThread: number[]) =>
    harness.run(async (ctx: any) => {
        const threadIds: string[] = [];

        for (const [index, rows] of rowsPerThread.entries()) {
            const threadId: string = await ctx.db.insert("threads", {
                mode: "text",
                model: "gpt-4o",
                status: "active",
                title: `Thread ${index}`,
                updatedAt: 1,
                userId: OWNER,
            });

            threadIds.push(threadId);

            for (let order = 0; order < rows; order += 1) {
                await ctx.db.insert("messages", { order, status: "success", stepOrder: 0, text: "hello", threadId, tool: false, userId: OWNER });
            }
        }

        return threadIds;
    });

/** Calls the measurement page by page, as a caller does, and records the rows each call read. */
const measureShard = (harness: Harness) =>
    harness.run(async (ctx: any) => {
        const pageRows: number[] = [];
        let state: unknown;

        for (let calls = 0; calls < 10_000; calls += 1) {
            const result: any = await ctx.runQuery(measureShardPage, state ? { state } : {});

            pageRows.push(result.pageRows);
            state = result.state;

            if (result.done) {
                return { pageRows, state: result.state };
            }
        }

        throw new Error("the measurement did not finish");
    });

describe("measureShardPage on a shard with a 10,000-row thread", () => {
    // Seeding 10,000 rows is the slow part, so the shard is seeded and measured once for both tests below.
    let harness: Harness;
    let bigThread: string;
    let measured: Awaited<ReturnType<typeof measureShard>>;

    beforeAll(async () => {
        harness = lunoraTest(schema as never);

        const threadIds = await seedShard(harness, [BIG_THREAD_ROWS, ...smallThreadRows()]);

        bigThread = threadIds[0] as string;
        measured = await measureShard(harness);
    });

    afterAll(() => {
        harness.close();
    });

    it("reports the 10,000-row thread as the largest", () => {
        const { state } = measured;

        expect(state.largest[0]).toEqual({ rows: BIG_THREAD_ROWS, threadId: bigThread });
        expect(state.messageRows).toBe(BIG_THREAD_ROWS + SMALL_THREAD_COUNT * SMALL_THREAD_ROWS);
        expect(state.threads).toBe(SMALL_THREAD_COUNT + 1);
        expect(state.approxBytes).toBeGreaterThan(state.messageRows);
    });

    it("reads at most one page per call and continues by cursor until done", () => {
        const { pageRows } = measured;
        const threadPages = Math.ceil((SMALL_THREAD_COUNT + 1) / FOOTPRINT_PAGE_SIZE);
        const messagePages = Math.ceil((BIG_THREAD_ROWS + SMALL_THREAD_COUNT * SMALL_THREAD_ROWS) / FOOTPRINT_PAGE_SIZE);

        // Calls that read nothing (a page that ends exactly on a boundary) are ignored.
        expect(Math.max(...pageRows)).toBeLessThanOrEqual(FOOTPRINT_PAGE_SIZE);
        expect(pageRows.filter((rows) => rows > 0)).toHaveLength(threadPages + messagePages);
    });
});

describe("measureShardPage on small shards", () => {
    let harness: Harness;

    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    it("counts a thread with no messages in the stored size", async () => {
        await seedShard(harness, [0]);
        const { state } = await measureShard(harness);

        expect(state.threads).toBe(1);
        expect(state.messageRows).toBe(0);
        expect(state.approxBytes).toBeGreaterThan(0);
    });

    it("keeps the largest list at the cap, biggest first", async () => {
        // Threads with 1 to 25 rows: the cap keeps the 20 biggest.
        await seedShard(
            harness,
            Array.from({ length: 25 }, (_, index) => index + 1),
        );
        const { state } = await measureShard(harness);

        expect(state.largest).toHaveLength(LARGEST_THREAD_COUNT);
        expect(state.largest[0]?.rows).toBe(25);
        expect(state.largest.at(-1)?.rows).toBe(6);
    });
});

describe("scan state", () => {
    it("drops thread ids from the cursor but keeps the counts", () => {
        const state = {
            ...startFootprint(),
            currentRows: 4,
            currentThreadId: "thread-x",
            largest: [{ rows: 9, threadId: "thread-y" }],
            messageRows: 13,
            threads: 2,
        };
        const carried = forCursor(state);

        expect(JSON.stringify(carried)).not.toContain("thread-");
        expect(carried).toMatchObject({ messageRows: 13, threads: 2 });
    });

    it("carries a thread's row count across pages", () => {
        let state = startFootprint();

        state = addMessageRow(state, "thread-a", 10);
        state = addMessageRow(state, "thread-a", 10);
        state = addMessageRow(state, "thread-b", 5);

        expect(state.messageRows).toBe(3);
        expect(state.approxBytes).toBe(25);
        expect(state.largest).toEqual([{ rows: 2, threadId: "thread-a" }]);
        expect(state.currentThreadId).toBe("thread-b");
    });
});

/** Shards that each need {@link PAGES_NEEDED} pages; `state.threads` counts the pages read so far. */
const PAGES_NEEDED = 5;

const fakeEntries = (count: number): ScanEntry[] =>
    Array.from({ length: count }, (_, index) => {
        return { shardKey: `shard-${index}`, state: startFootprint(), status: "active" };
    });

const fakePage = async (entry: ScanEntry) => {
    const pages = entry.state.threads + 1;

    return { done: pages >= PAGES_NEEDED, state: { ...entry.state, threads: pages } };
};

describe("census scheduling", () => {
    it("stops at the call budget and resumes unfinished shards from their carried state", async () => {
        const entries = fakeEntries(10);

        // 10 shards of 5 pages each would need 50 calls; the budget is 40, so 4 pages each are read.
        const first = await runScanRounds(entries, fakePage, MAX_SHARD_CALLS_PER_ACTION);

        expect(first).toBe(MAX_SHARD_CALLS_PER_ACTION);
        expect(entries.every((entry) => entry.status === "active")).toBe(true);
        expect(entries.every((entry) => entry.state.threads === 4)).toBe(true);

        // The next call continues the same shards: one more page each finishes them.
        const second = await runScanRounds(entries, fakePage, MAX_SHARD_CALLS_PER_ACTION);

        expect(second).toBe(entries.length);
        expect(entries.every((entry) => entry.status === "done")).toBe(true);
    });

    it("marks a shard whose read throws as failed and does not read it again", async () => {
        const entries = fakeEntries(3);
        const readPage = async (entry: ScanEntry) => {
            if (entry.shardKey === "shard-1") {
                throw new Error("shard unavailable");
            }

            return await fakePage(entry);
        };

        const calls = await runScanRounds(entries, readPage, MAX_SHARD_CALLS_PER_ACTION);

        expect(entries.map((entry) => entry.status)).toEqual(["done", "failed", "done"]);
        // The failure keeps its name and its last good state (no page was counted), so a later call can retry it.
        expect(entries[1]?.errorName).toBe("Error");
        expect(entries[1]?.state.threads).toBe(0);
        // One round of 3 calls, then 4 more rounds of the 2 healthy shards.
        expect(calls).toBe(3 + 2 * (PAGES_NEEDED - 1));
    });

    it("round-trips the census cursor through its opaque encoding and rejects anything else", () => {
        const cursor: CensusCursor = {
            census: "census-cursor",
            censusDone: false,
            pending: [{ shardKey: "user-1", state: { ...startFootprint(), largest: [{ rows: 2, threadId: "thread-1" }], threads: 3 } }],
        };

        // The thread ids in each pending state are dropped on the way out; the counts survive.
        const encoded = encodeCensusCursor(cursor);

        expect(decodeCensusCursor(encoded)).toMatchObject({ census: "census-cursor", pending: [{ shardKey: "user-1", state: { threads: 3 } }] });
        expect(decodeCensusCursor(encoded)?.pending[0]?.state.largest).toEqual([]);
        expect(decodeCensusCursor("not a cursor!")).toBeUndefined();
        expect(decodeCensusCursor(btoa(JSON.stringify({ census: 1 })))).toBeUndefined();
    });

    it("seeds the root shard into the first call only, so anonymous conversations are measured once", () => {
        const first = withRootShard(startCensus(), "__root__");

        expect(first.pending).toEqual([{ shardKey: "__root__", state: startFootprint() }]);
        expect(withRootShard(first, "__root__")).toEqual(first);
        expect(withRootShard({ census: "next-page", censusDone: false, pending: [] }, "__root__").pending).toEqual([]);
    });

    it("measures the root shard once when routing is collapsed, however often it is asked", () => {
        const once = rootOnlyCensus(startCensus(), "__root__");

        expect(once).toEqual({ census: null, censusDone: true, pending: [{ shardKey: "__root__", state: startFootprint() }] });
        expect(rootOnlyCensus(once, "__root__")).toEqual(once);
    });
});
