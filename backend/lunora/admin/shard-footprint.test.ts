/**
 * The shard footprint scan: the 10,000-row thread is the largest, a call reads at most one page,
 * the largest list stays capped at {@link LARGEST_THREAD_COUNT}, a call stays within its shard-call
 * budget, and an unfinished shard resumes from its carried state.
 */
import { lunoraTest } from "@lunora/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { decodeCensusCursor, encodeCensusCursor, measureShardPage } from "./cleanup";
import {
    addMessageRow,
    approxRowBytes,
    type BreakdownEntry,
    type CensusCursor,
    classifyThread,
    FOOTPRINT_PAGE_SIZE,
    forCursor,
    keepTop,
    LARGE_TOOL_ROW_BYTES,
    largestRowsOf,
    LARGEST_THREAD_COUNT,
    mergeBreakdowns,
    MAX_SHARD_CALLS_PER_ACTION,
    MAX_SHARD_FAILURES,
    rootOnlyCensus,
    runScanRounds,
    type ScanEntry,
    startCensus,
    startFootprint,
    type ThreadClass,
    willRetry,
    withRootShard,
} from "./shard-footprint-logic";

// The census cursor is sealed with a key derived from ENCRYPTION_KEY, which `encryption.ts` reads at load.
vi.hoisted(() => {
    process.env["ENCRYPTION_KEY"] = btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32))));
});

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "user-owner";
/** The clock every measurement in this file runs at. */
const NOW = Date.UTC(2026, 10, 21);
const DAY_MS = 24 * 60 * 60 * 1000;
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

/**
 * Calls the measurement page by page, as a caller does, and records the rows each call read. With `throughCursor`, every
 * page's state goes through the browser cursor's form first, as if each page were its own admin call.
 */
const measureShard = (harness: Harness, { throughCursor = false } = {}) =>
    harness.run(async (ctx: any) => {
        const pageRows: number[] = [];
        let state: unknown;

        for (let calls = 0; calls < 10_000; calls += 1) {
            const result: any = await ctx.runQuery(measureShardPage, state ? { now: NOW, state } : { now: NOW });

            pageRows.push(result.pageRows);
            state = throughCursor ? forCursor(result.state) : result.state;

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

    it("counts the 10,000-row thread whole when each page is its own admin call", async () => {
        const { state } = await measureShard(harness, { throughCursor: true });

        expect(largestRowsOf(state)[0]).toBe(BIG_THREAD_ROWS);
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

const ACTIVE_NEW: ThreadClass = { group: "active", sinceDays: 0 };

/** The breakdown entry of one group and age band, or `undefined` when nothing fell in it. */
const entryOf = (breakdown: BreakdownEntry[], group: ThreadClass["group"], sinceDays: number) =>
    breakdown.find((entry) => entry.group === group && entry.sinceDays === sinceDays);

describe("measureShardPage breakdown by thread group and age band", () => {
    let harness: Harness;

    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    it("counts each thread and row in its group and age band, with tool results and large tool results apart", async () => {
        await harness.run(async (ctx: any) => {
            const thread = (fields: Record<string, unknown>) =>
                ctx.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "t", userId: OWNER, ...fields });
            const message = (threadId: string, order: number, fields: Record<string, unknown>) =>
                ctx.db.insert("messages", { order, status: "success", stepOrder: 0, text: "hello", threadId, tool: false, userId: OWNER, ...fields });

            const recent = await thread({ updatedAt: NOW - DAY_MS });

            await message(recent, 0, {});
            await message(recent, 1, {});

            const idle = await thread({ updatedAt: NOW - 10 * DAY_MS });

            await message(idle, 0, {});

            const archived = await thread({ status: "archived", updatedAt: NOW - 100 * DAY_MS });

            const toolResult = (output: string) => {
                return { message: { content: [{ output, type: "tool-result" }], role: "tool" }, tool: true };
            };

            await message(archived, 0, {});
            await message(archived, 1, toolResult("small tool output"));
            await message(archived, 2, toolResult("x".repeat(LARGE_TOOL_ROW_BYTES)));
            // A large call request is a tool row, but not tool output.
            await message(archived, 3, {
                message: { content: [{ input: "y".repeat(LARGE_TOOL_ROW_BYTES), type: "tool-call" }], role: "assistant" },
                tool: true,
            });

            await thread({ pinnedAt: NOW, status: "archived", updatedAt: NOW - 400 * DAY_MS });
            await thread({ deleted: true, deletedAt: NOW, updatedAt: NOW - 5 * DAY_MS });

            // A running thread is active now, however long ago it was last updated.
            const running = await thread({ status: "running", updatedAt: NOW - 40 * DAY_MS });

            await message(running, 0, {});

            // A message whose thread is gone counts as `other`, in the newest band.
            const gone = await thread({ updatedAt: NOW });

            await ctx.db.delete("threads", gone);
            await message(gone, 0, {});
        });

        const { state } = await measureShard(harness);
        const { breakdown } = state as { breakdown: BreakdownEntry[] };

        expect(entryOf(breakdown, "active", 0)).toMatchObject({ messageRows: 3, threads: 2, toolBytes: 0 });
        expect(entryOf(breakdown, "active", 30)).toBeUndefined();
        expect(entryOf(breakdown, "active", 7)).toMatchObject({ messageRows: 1, threads: 1 });

        const archivedEntry = entryOf(breakdown, "archived", 90);

        expect(archivedEntry).toMatchObject({ largeToolRows: 1, messageRows: 4, threads: 1 });
        expect(archivedEntry?.largeToolBytes).toBeGreaterThanOrEqual(LARGE_TOOL_ROW_BYTES);
        expect(archivedEntry?.toolBytes).toBeGreaterThan(archivedEntry?.largeToolBytes ?? 0);
        // The call request's bytes count in the size, not in the tool output.
        expect(archivedEntry?.toolBytes).toBeLessThan(2 * LARGE_TOOL_ROW_BYTES);
        expect(archivedEntry?.approxBytes).toBeGreaterThan(2 * LARGE_TOOL_ROW_BYTES);
        expect(entryOf(breakdown, "pinned", 365)).toMatchObject({ messageRows: 0, threads: 1 });
        expect(entryOf(breakdown, "other", 3)).toMatchObject({ threads: 1 });
        expect(entryOf(breakdown, "other", 0)).toMatchObject({ messageRows: 1, threads: 0 });

        const summed = { approxBytes: 0, messageRows: 0, threads: 0 };

        for (const entry of breakdown) {
            summed.approxBytes += entry.approxBytes;
            summed.messageRows += entry.messageRows;
            summed.threads += entry.threads;
        }

        expect(summed).toEqual({ approxBytes: state.approxBytes, messageRows: state.messageRows, threads: state.threads });
    });
});

describe("thread classes and merges", () => {
    const base = { _creationTime: NOW - 50 * DAY_MS, status: "active" };

    it("bands a thread by the days since updatedAt, falling back to creation time", () => {
        expect(classifyThread({ ...base, updatedAt: NOW }, NOW)).toEqual({ group: "active", sinceDays: 0 });
        expect(classifyThread({ ...base, updatedAt: NOW - 3 * DAY_MS }, NOW)).toEqual({ group: "active", sinceDays: 3 });
        expect(classifyThread({ ...base, updatedAt: NOW - 29 * DAY_MS }, NOW)).toEqual({ group: "active", sinceDays: 14 });
        expect(classifyThread({ ...base, updatedAt: NOW - 365 * DAY_MS }, NOW)).toEqual({ group: "active", sinceDays: 365 });
        expect(classifyThread(base, NOW)).toEqual({ group: "active", sinceDays: 30 });
        // A clock behind the row's time is the newest band, never a negative one.
        expect(classifyThread({ ...base, updatedAt: NOW + DAY_MS }, NOW)).toEqual({ group: "active", sinceDays: 0 });
    });

    it("puts a running thread in the first band, whatever its updatedAt", () => {
        expect(classifyThread({ ...base, status: "running", updatedAt: NOW - 100 * DAY_MS }, NOW)).toEqual({ group: "active", sinceDays: 0 });
    });

    it("puts trashed, temporary and deleting threads in other, and pinned before archived", () => {
        expect(classifyThread({ ...base, deleted: true, pinnedAt: NOW, updatedAt: NOW }, NOW).group).toBe("other");
        expect(classifyThread({ ...base, isTemporary: true, updatedAt: NOW }, NOW).group).toBe("other");
        expect(classifyThread({ ...base, deletingAt: NOW, status: "archived", updatedAt: NOW }, NOW).group).toBe("other");
        expect(classifyThread({ ...base, pinnedAt: NOW, status: "archived", updatedAt: NOW }, NOW).group).toBe("pinned");
        expect(classifyThread({ ...base, status: "archived", updatedAt: NOW }, NOW).group).toBe("archived");
        expect(classifyThread(null, NOW)).toEqual({ group: "other", sinceDays: 0 });
    });

    it("sums breakdowns by group and age band, and keeps the largest numbers", () => {
        const entry = (group: ThreadClass["group"], sinceDays: number, threads: number): BreakdownEntry => {
            return { approxBytes: threads * 10, group, largeToolBytes: 0, largeToolRows: 0, messageRows: threads, sinceDays, threads, toolBytes: 0 };
        };

        expect(mergeBreakdowns([entry("archived", 30, 1), entry("active", 0, 2)], [entry("active", 0, 3), entry("pinned", 7, 1)])).toEqual([
            entry("active", 0, 5),
            entry("archived", 30, 1),
            entry("pinned", 7, 1),
        ]);
        expect(keepTop([3, 9, 1, 7], 3)).toEqual([9, 7, 3]);
    });
});

describe("scan state", () => {
    it("drops the largest list's ids from the cursor, and keeps the thread the scan is in", () => {
        const state = {
            ...startFootprint(),
            currentClass: ACTIVE_NEW,
            currentRows: 4,
            currentThreadId: "thread-x",
            largest: [{ rows: 9, threadId: "thread-y" }],
            messageRows: 13,
            threads: 2,
        };
        const carried = forCursor(state);

        expect(JSON.stringify(carried)).not.toContain("thread-y");
        expect(carried).toMatchObject({
            carriedLargestRows: [9],
            currentClass: ACTIVE_NEW,
            currentRows: 4,
            currentThreadId: "thread-x",
            messageRows: 13,
            threads: 2,
        });
        expect(largestRowsOf({ ...carried, largest: [{ rows: 12, threadId: "thread-z" }] })).toEqual([12, 9]);
    });

    it("carries a thread's row count across pages", () => {
        let state = startFootprint();

        state = addMessageRow(state, { bytes: 10, threadClass: ACTIVE_NEW, threadId: "thread-a", toolOutput: false });
        state = addMessageRow(state, { bytes: 10, threadClass: ACTIVE_NEW, threadId: "thread-a", toolOutput: false });
        state = addMessageRow(state, { bytes: 5, threadClass: ACTIVE_NEW, threadId: "thread-b", toolOutput: false });

        expect(state.messageRows).toBe(3);
        expect(state.approxBytes).toBe(25);
        expect(state.largest).toEqual([{ rows: 2, threadId: "thread-a" }]);
        expect(state.currentThreadId).toBe("thread-b");
    });

    it("retries a failing shard until it has failed MAX_SHARD_FAILURES times in a row, then gives it up", () => {
        expect(willRetry(1)).toBe(true);
        expect(willRetry(MAX_SHARD_FAILURES - 1)).toBe(true);
        expect(willRetry(MAX_SHARD_FAILURES)).toBe(false);
    });

    it("measures a row with a bigint, and counts the bytes of an inline binary value", () => {
        expect(approxRowBytes({ count: 1n })).toBe(new TextEncoder().encode('{"count":"1"}').byteLength);
        expect(approxRowBytes({ data: new Uint8Array(65_536) })).toBeGreaterThanOrEqual(65_536);
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

    it("marks a shard that read successfully earlier in the call, so a later failure restarts its count", async () => {
        const entries = fakeEntries(1);
        let reads = 0;
        const readPage = async (entry: ScanEntry) => {
            reads += 1;

            if (reads === 2) {
                throw new Error("late failure");
            }

            return await fakePage(entry);
        };

        await runScanRounds(entries, readPage, MAX_SHARD_CALLS_PER_ACTION);

        expect(entries[0]?.status).toBe("failed");
        expect(entries[0]?.succeeded).toBe(true);
    });

    it("round-trips the census cursor sealed, so the browser cannot read or alter it, and rejects anything else", async () => {
        const cursor: CensusCursor = {
            census: "census-cursor",
            censusDone: false,
            pending: [
                {
                    shardKey: "user-1",
                    state: { ...startFootprint(), currentRows: 4, currentThreadId: "thread-current", largest: [{ rows: 2, threadId: "thread-1" }], threads: 3 },
                },
            ],
            startedAt: NOW,
        };
        const encoded = await encodeCensusCursor(cursor);

        // Neither the shard key nor any thread id can be read from the string, in plain or base64 form.
        for (const name of ["user-1", "thread-current", "thread-1"]) {
            expect(encoded).not.toContain(name);
            expect(atob(encoded.slice("v1:".length))).not.toContain(name);
        }

        const decoded = await decodeCensusCursor(encoded);

        // The largest list's ids are dropped on the way out; the thread the scan is in, the counts and the clock survive.
        expect(decoded).toMatchObject({
            census: "census-cursor",
            pending: [{ shardKey: "user-1", state: { currentRows: 4, currentThreadId: "thread-current", threads: 3 } }],
            startedAt: NOW,
        });
        expect(decoded?.pending[0]?.state.largest).toEqual([]);

        // A changed byte fails the seal.
        const last = encoded.at(-2) === "A" ? "B" : "A";

        expect(await decodeCensusCursor(`${encoded.slice(0, -2)}${last}${encoded.slice(-1)}`)).toBeUndefined();
        expect(await decodeCensusCursor("not a cursor!")).toBeUndefined();
        // The unsealed form the cursor had before is not a cursor.
        expect(await decodeCensusCursor(btoa(JSON.stringify(cursor)))).toBeUndefined();
    });

    it("seeds the root shard into the first call only, so anonymous conversations are measured once", () => {
        const first = withRootShard(startCensus(NOW), "__root__");

        expect(first.pending).toEqual([{ shardKey: "__root__", state: startFootprint() }]);
        expect(withRootShard(first, "__root__")).toEqual(first);
        expect(withRootShard({ census: "next-page", censusDone: false, pending: [], startedAt: NOW }, "__root__").pending).toEqual([]);
    });

    it("measures the root shard once when routing is collapsed, however often it is asked", () => {
        const once = rootOnlyCensus(startCensus(NOW), "__root__");

        expect(once).toEqual({ census: null, censusDone: true, pending: [{ shardKey: "__root__", state: startFootprint() }], startedAt: NOW });
        expect(rootOnlyCensus(once, "__root__")).toEqual(once);
    });
});
