/**
 * The purge deletes a finished stream and its chunks once it is well past its
 * expiry, a bounded batch per run. A live stream, or one finished recently
 * enough for a late poll, is never touched.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../../../schema";
import { PURGE_CHUNK_BATCH, PURGE_LARGE_STREAMS_PER_RUN, PURGE_SCAN_PAGES, PURGE_STREAM_BATCH, purgeFinishedStreams, STREAM_RETENTION_MS } from "./purge";

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

const purge = async (): Promise<{ chunks: number; streams: number }> => await harness.run(async (ctx: any) => await ctx.runMutation(purgeFinishedStreams, {}));

const count = async (table: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const rows = await ctx.db.query(table).collect();

        return rows.length;
    });

const exists = async (id: string): Promise<boolean> =>
    await harness.run(async (ctx: any) => (await ctx.db.persistentStreams.findFirst({ where: { _id: id } })) !== null);

describe("purgeFinishedStreams", () => {
    it("removes old finished streams and their chunks across batches", async () => {
        const run = PURGE_STREAM_BATCH * PURGE_SCAN_PAGES;
        const total = run + 10;

        for (let index = 0; index < total; index += 1) {
            await insertStream(["done", "error", "timeout"][index % 3]!, OLD());
        }

        await expect(purge()).resolves.toStrictEqual({ chunks: run * 2, streams: run });
        expect(await count("persistentStreams")).toBe(10);

        await expect(purge()).resolves.toStrictEqual({ chunks: 20, streams: 10 });
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
        const big = await insertStream("done", OLD(), PURGE_CHUNK_BATCH + 5);

        await expect(purge()).resolves.toStrictEqual({ chunks: PURGE_CHUNK_BATCH, streams: 0 });
        expect(await exists(big)).toBe(true);

        await expect(purge()).resolves.toStrictEqual({ chunks: 5, streams: 1 });
        expect(await exists(big)).toBe(false);
        expect(await count("persistentChunks")).toBe(0);
    });

    it("reaches a small expired stream queued behind a page of big ones", async () => {
        for (let index = 0; index < PURGE_STREAM_BATCH; index += 1) {
            await insertStream("done", OLD(), PURGE_CHUNK_BATCH * 3);
        }

        const small = await insertStream("done", OLD());

        await purge();

        expect(await exists(small)).toBe(false);
        // Only a few big streams are worked on per run.
        expect(await count("persistentChunks")).toBe(PURGE_STREAM_BATCH * PURGE_CHUNK_BATCH * 3 - PURGE_LARGE_STREAMS_PER_RUN * PURGE_CHUNK_BATCH);
    });
});
