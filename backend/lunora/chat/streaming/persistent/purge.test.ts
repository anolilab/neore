/**
 * The purge deletes a finished stream and its chunks once it is well past its
 * expiry, a bounded batch per run. A live stream, or one finished recently
 * enough for a late poll, is never touched.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../../../schema";
import { PURGE_OP_BUDGET, PURGE_STREAM_BATCH, purgeFinishedStreams, STREAM_RETENTION_MS } from "./purge";

const OWNER = "user-owner";
const HOUR = 60 * 60 * 1000;
const OLD = () => Date.now() - STREAM_RETENTION_MS - HOUR;

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const insertStream = async (status: string, expiresAt: number, chunks = 2): Promise<string> =>
    await harness.run(async (ctx: any) => {
        const id = await ctx.db.insert("persistentStreams", {
            expiresAt,
            messageId: "m",
            status,
            streamingConfig: { contentType: "text", model: "m" },
            threadId: "t",
            userId: OWNER,
        });

        for (let seq = 0; seq < chunks; seq += 1) {
            await ctx.db.insert("persistentChunks", { seq, streamId: id, text: "x" });
        }

        return id;
    });

// The paging is the same at any budget, so most tests pass a small one instead of inserting thousands of rows.
const purge = async (budget?: number): Promise<{ chunks: number; streams: number }> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(purgeFinishedStreams, budget === undefined ? {} : { budget }));

const count = async (table: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const rows = await ctx.db.query(table).collect();

        return rows.length;
    });

const exists = async (id: string): Promise<boolean> =>
    await harness.run(async (ctx: any) => (await ctx.db.persistentStreams.findFirst({ where: { _id: id } })) !== null);

describe("purgeFinishedStreams", () => {
    it("removes old finished streams of every terminal status, across pages, with their chunks", async () => {
        const total = PURGE_STREAM_BATCH * 2 + 10;

        for (let index = 0; index < total; index += 1) {
            await insertStream(["done", "error", "timeout"][index % 3]!, OLD());
        }

        await expect(purge()).resolves.toStrictEqual({ chunks: total * 2, streams: total });
        expect(await count("persistentStreams")).toBe(0);
        expect(await count("persistentChunks")).toBe(0);
    });

    it("clears a backlog of small streams beyond one page within the op budget (3 ops each)", async () => {
        const budget = 90;
        const total = 100;

        for (let index = 0; index < total; index += 1) {
            await insertStream("done", OLD());
        }

        const first = await purge(budget);

        expect(first.chunks + first.streams).toBe(budget);
        expect(first.streams).toBeGreaterThan(PURGE_STREAM_BATCH);

        for (let run = 1; run < Math.ceil((total * 3) / budget); run += 1) {
            await purge(budget);
        }

        expect(await count("persistentStreams")).toBe(0);
        expect(await count("persistentChunks")).toBe(0);
    });

    it("keeps live streams, recent finished ones, and another stream's chunks", async () => {
        const pending = await insertStream("pending", OLD());
        const streaming = await insertStream("streaming", OLD());
        const recent = await insertStream("done", Date.now() - HOUR);
        const old = await insertStream("done", OLD());

        await purge();

        expect(await exists(old)).toBe(false);

        for (const kept of [pending, streaming, recent]) {
            expect(await exists(kept)).toBe(true);
        }

        expect(await count("persistentChunks")).toBe(6);
    });

    it("finishes a stream with more chunks than one run deletes on a later run", async () => {
        const budget = 10;
        const big = await insertStream("done", OLD(), budget + 5);

        await expect(purge(budget)).resolves.toStrictEqual({ chunks: budget, streams: 0 });
        expect(await exists(big)).toBe(true);

        await expect(purge(budget)).resolves.toStrictEqual({ chunks: 5, streams: 1 });
        expect(await exists(big)).toBe(false);
        expect(await count("persistentChunks")).toBe(0);
    });

    it("clears a backlog of more large streams than one run scans, and the small stream behind them, in ceil(chunks / budget) runs", async () => {
        const budget = 100;
        const largeStreams = PURGE_STREAM_BATCH * 2 + 5;
        const perStream = 11;

        for (let index = 0; index < largeStreams; index += 1) {
            await insertStream("done", OLD(), perStream);
        }

        const small = await insertStream("done", OLD());
        const runs = Math.ceil((largeStreams * (perStream + 1) + 3) / budget);

        for (let run = 0; run < runs; run += 1) {
            await purge(budget);
        }

        expect(await exists(small)).toBe(false);
        expect(await count("persistentStreams")).toBe(0);
        expect(await count("persistentChunks")).toBe(0);
    });

    it("spends the default budget when none is given", async () => {
        const big = await insertStream("done", OLD(), PURGE_OP_BUDGET + 1);

        await expect(purge()).resolves.toStrictEqual({ chunks: PURGE_OP_BUDGET, streams: 0 });
        expect(await exists(big)).toBe(true);
    }, 30_000); // inserts PURGE_OP_BUDGET + 1 rows one by one; the one test that must prove the real constant
});
