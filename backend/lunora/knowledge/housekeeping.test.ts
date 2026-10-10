/**
 * Knowledge-file upkeep: a marked file is drained in bounded steps, an ingest
 * that outlived its action is failed, and an ingest still running for a file
 * that was removed cannot write it back.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { DELETING_STATUS } from "./file-removal";
import { saveChunks, updateFileStatus } from "./functions";
import { CHUNKS_PER_DRAIN_STEP, drainDeletingFiles, isStuckIngest, STUCK_INGEST_MS, sweepKnowledgeFiles } from "./housekeeping";

type Harness = ReturnType<typeof lunoraTest>;

const USER = "user-a";

let harness: Harness;

const newFile = async (extra: Record<string, unknown> = {}): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("knowledgeFiles", {
                createdAt: Date.now(),
                mimeType: "text/plain",
                name: "f.txt",
                size: 1,
                status: "indexed",
                userId: USER,
                ...extra,
            }),
    );

const addChunks = async (fileId: string, count: number): Promise<void> => {
    await harness.run(async (ctx: any) => {
        for (let index = 0; index < count; index += 1) {
            await ctx.db.insert("knowledgeChunks", { chunkIndex: index, content: `c${String(index)}`, fileId, userId: USER });
        }
    });
};

const chunksOf = async (fileId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const chunks = await ctx.db
            .query("knowledgeChunks")
            .withIndex("by_fileId_chunkIndex", (q: any) => q.eq("fileId", fileId))
            .collect();

        return chunks.length;
    });

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("drainDeletingFiles", () => {
    it("removes a large marked file over several bounded steps, and leaves other files alone", async () => {
        const big = await newFile({ status: DELETING_STATUS });
        const kept = await newFile();

        await addChunks(big, CHUNKS_PER_DRAIN_STEP + 10);
        await addChunks(kept, 3);

        const first = (await harness.run(async (ctx: any) => await ctx.runMutation(drainDeletingFiles, {}))) as { more: boolean };

        expect(first.more).toBe(true);
        expect(await chunksOf(big)).toBe(10);
        expect(await harness.run(async (ctx: any) => await ctx.db.get(big))).not.toBeNull();

        const second = (await harness.run(async (ctx: any) => await ctx.runMutation(drainDeletingFiles, {}))) as { more: boolean };

        expect(second.more).toBe(false);
        expect(await chunksOf(big)).toBe(0);
        expect(await harness.run(async (ctx: any) => await ctx.db.get(big))).toBeNull();
        expect(await chunksOf(kept)).toBe(3);
    });
});

describe("sweepKnowledgeFiles", () => {
    it("fails ingests that outlived their action, and nothing that is still in time", async () => {
        const now = Date.now();
        const stuck = await newFile({ status: "processing", updatedAt: now - STUCK_INGEST_MS - 1000 });
        const running = await newFile({ status: "processing", updatedAt: now });
        const lost = await newFile({ createdAt: now - STUCK_INGEST_MS - 1000, status: "pending" });

        const result = (await harness.run(async (ctx: any) => await ctx.runMutation(sweepKnowledgeFiles, {}))) as { reaped: number };

        expect(result.reaped).toBe(2);

        const [stuckRow, runningRow, lostRow] = await harness.run(async (ctx: any) => [
            await ctx.db.get(stuck),
            await ctx.db.get(running),
            await ctx.db.get(lost),
        ]);

        expect(stuckRow.status).toBe("failed");
        expect(lostRow.status).toBe("failed");
        expect(runningRow.status).toBe("processing");
    });

    it("isStuckIngest ignores finished files", () => {
        expect(isStuckIngest({ createdAt: 0, status: "indexed" }, STUCK_INGEST_MS * 10)).toBe(false);
        expect(isStuckIngest({ createdAt: 0, status: "processing" }, STUCK_INGEST_MS + 1)).toBe(true);
    });
});

describe("an ingest racing a removal", () => {
    it("cannot write status or chunks for a file being removed or already gone", async () => {
        const marked = await newFile({ status: DELETING_STATUS });
        const gone = await newFile();

        await harness.run(async (ctx: any) => await ctx.db.delete(gone));

        for (const fileId of [marked, gone]) {
            await expect(harness.run(async (ctx: any) => await ctx.runMutation(updateFileStatus, { fileId, status: "indexed" }))).resolves.toBe(false);
            await expect(
                harness.run(async (ctx: any) => await ctx.runMutation(saveChunks, { chunks: [{ chunkIndex: 0, content: "x" }], fileId, userId: USER })),
            ).resolves.toBe(false);
        }

        expect(await chunksOf(marked)).toBe(0);
        const markedRow = await harness.run(async (ctx: any) => await ctx.db.get(marked));

        expect(markedRow.status).toBe(DELETING_STATUS);
    });
});
