/**
 * The shard footprint scan: the 10,000-row thread is the largest, a call reads at most one page,
 * and the largest list stays capped at {@link LARGEST_THREAD_COUNT}.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { addMessageRow, FOOTPRINT_PAGE_SIZE, LARGEST_THREAD_COUNT, startFootprint } from "./shard-footprint-logic";
import { measureShardPage } from "./cleanup";

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "user-owner";
const BIG_THREAD_ROWS = 10_000;
const SMALL_THREAD_COUNT = 30;
const SMALL_THREAD_ROWS = 3;
/** Generous: seeding 10,000 rows takes a few seconds on the in-memory store. */
const SEED_TIMEOUT_MS = 60_000;

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

/** Row counts of the small threads: {@link SMALL_THREAD_COUNT} threads of {@link SMALL_THREAD_ROWS} rows each. */
const smallThreadRows = (): number[] => {
    const rows: number[] = [];

    for (let index = 0; index < SMALL_THREAD_COUNT; index += 1) {
        rows.push(SMALL_THREAD_ROWS);
    }

    return rows;
};

/** Seeds one thread per entry of `rowsPerThread` and returns the thread ids in that order. */
const seedShard = (rowsPerThread: number[]) =>
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
const measureShard = () =>
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

describe("measureShardPage", () => {
    it(
        "reports the 10,000-row thread as the largest",
        async () => {
            const [bigThread] = await seedShard([BIG_THREAD_ROWS, ...smallThreadRows()]);
            const { state } = await measureShard();

            expect(state.largest[0]).toEqual({ rows: BIG_THREAD_ROWS, threadId: bigThread });
            expect(state.messageRows).toBe(BIG_THREAD_ROWS + SMALL_THREAD_COUNT * SMALL_THREAD_ROWS);
            expect(state.threads).toBe(SMALL_THREAD_COUNT + 1);
            expect(state.approxBytes).toBeGreaterThan(state.messageRows);
        },
        SEED_TIMEOUT_MS,
    );

    it(
        "reads at most one page per call and continues by cursor until done",
        async () => {
            await seedShard([BIG_THREAD_ROWS, ...smallThreadRows()]);
            const { pageRows } = await measureShard();
            const threadPages = Math.ceil((SMALL_THREAD_COUNT + 1) / FOOTPRINT_PAGE_SIZE);
            const messagePages = Math.ceil((BIG_THREAD_ROWS + SMALL_THREAD_COUNT * SMALL_THREAD_ROWS) / FOOTPRINT_PAGE_SIZE);

            // Calls that read nothing (a page that ends exactly on a boundary) are ignored.
            expect(Math.max(...pageRows)).toBeLessThanOrEqual(FOOTPRINT_PAGE_SIZE);
            expect(pageRows.filter((rows) => rows > 0)).toHaveLength(threadPages + messagePages);
        },
        SEED_TIMEOUT_MS,
    );

    it(
        "keeps the largest list at the cap, biggest first",
        async () => {
            // Threads with 1 to 25 rows: the cap keeps the 20 biggest.
            await seedShard(Array.from({ length: 25 }, (_, index) => index + 1));
            const { state } = await measureShard();

            expect(state.largest).toHaveLength(LARGEST_THREAD_COUNT);
            expect(state.largest[0]?.rows).toBe(25);
            expect(state.largest.at(-1)?.rows).toBe(6);
        },
        SEED_TIMEOUT_MS,
    );
});

describe("scan state", () => {
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
