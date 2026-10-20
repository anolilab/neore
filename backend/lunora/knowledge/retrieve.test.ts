/**
 * Knowledge search carries each chunk's file id through both legs and the RRF
 * fusion, next to the fields its callers already read (the chat tool, the
 * agent-run context and the public API's `searchKnowledge`, whose output
 * validator keeps its narrower shape). Eval runs match expected sources by it.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { getChunksByEmbeddingIds, keywordSearchChunks, recordKnowledgeSources, saveChunks } from "./functions";
import { readKnowledgeCitation, toKnowledgeSource } from "./citations";
import { fuseSearchLegs } from "./retrieve";

type Harness = ReturnType<typeof lunoraTest>;

const USER = "user-a";

let harness: Harness;
let fileId: string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    fileId = await harness.run(async (ctx: any) => {
        const id = await ctx.db.insert("knowledgeFiles", {
            chunkCount: 1,
            createdAt: 1,
            mimeType: "text/plain",
            name: "refunds.txt",
            size: 1,
            status: "indexed",
            userId: USER,
        });

        await ctx.db.insert("knowledgeChunks", {
            chunkIndex: 0,
            content: "Refunds are accepted within thirty days.",
            embeddingId: "emb-1",
            fileId: id,
            userId: USER,
        });

        return id;
    });
});

afterEach(() => {
    harness.close();
});

describe("knowledge search file ids", () => {
    it("returns the file id from the vector leg's chunk lookup", async () => {
        const rows = await harness.run(
            async (ctx: any) => await ctx.runQuery(getChunksByEmbeddingIds, { embeddingIds: ["emb-1"], knowledgeFileIds: [fileId], userId: USER }),
        );

        expect(rows).toMatchObject([{ fileId, fileName: "refunds.txt" }]);
    });

    it("returns the vector leg's chunks in embedding-id order, and only the user's own", async () => {
        const { otherFileId } = await harness.run(async (ctx: any) => {
            const id = await ctx.db.insert("knowledgeFiles", {
                chunkCount: 2,
                createdAt: 1,
                mimeType: "text/plain",
                name: "shipping.txt",
                size: 1,
                status: "indexed",
                userId: USER,
            });

            await ctx.db.insert("knowledgeChunks", { chunkIndex: 0, content: "Ships in two days.", embeddingId: "emb-2", fileId: id, userId: USER });
            await ctx.db.insert("knowledgeChunks", { chunkIndex: 1, content: "Refunds take a week.", embeddingId: "emb-3", fileId, userId: USER });
            await ctx.db.insert("knowledgeChunks", { chunkIndex: 2, content: "Someone else's.", embeddingId: "emb-x", fileId: id, userId: "user-b" });

            return { otherFileId: id };
        });

        const rows = await harness.run(
            async (ctx: any) =>
                await ctx.runQuery(getChunksByEmbeddingIds, {
                    embeddingIds: ["emb-3", "emb-x", "emb-2", "emb-1", "emb-missing"],
                    knowledgeFileIds: [fileId, otherFileId],
                    userId: USER,
                }),
        );

        expect(rows.map((row: { embeddingId: string; fileName: string }) => [row.embeddingId, row.fileName])).toStrictEqual([
            ["emb-3", "refunds.txt"],
            ["emb-2", "shipping.txt"],
            ["emb-1", "refunds.txt"],
        ]);
    });

    it("returns the file id from the keyword leg", async () => {
        const rows = await harness.run(
            async (ctx: any) => await ctx.runQuery(keywordSearchChunks, { knowledgeFileIds: [fileId], limit: 5, query: "refunds thirty days", userId: USER }),
        );

        expect(rows).toMatchObject([{ fileId, fileName: "refunds.txt" }]);
    });

    it("keeps the file id through fusion, alongside the existing fields, once per chunk", () => {
        const chunk = { chunkId: "c1", chunkIndex: 0, content: "Refunds…", fileId: "f1", fileName: "refunds.txt" };
        const other = { chunkId: "c2", chunkIndex: 3, content: "Shipping…", fileId: "f2", fileName: "shipping.txt" };
        const hits = fuseSearchLegs([chunk, other], [chunk]);

        expect(hits.map(({ score: _score, ...rest }) => rest)).toStrictEqual([
            { chunkId: "c1", chunkIndex: 0, content: "Refunds…", fileId: "f1", fileName: "refunds.txt" },
            { chunkId: "c2", chunkIndex: 3, content: "Shipping…", fileId: "f2", fileName: "shipping.txt" },
        ]);
    });
});

describe("knowledge search pages", () => {
    it("writes the page a chunk starts on into its metadata, and nothing for a chunk without one", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.runMutation(saveChunks, {
                chunks: [
                    { chunkIndex: 1, content: "Ibex grazing rules.", pageNumber: 4, sectionHeading: "Grazing" },
                    { chunkIndex: 2, content: "No page here.", pageNumber: undefined },
                ],
                fileId,
                userId: USER,
            });
        });

        const rows = await harness.run(
            async (ctx: any) =>
                await ctx.db
                    .query("knowledgeChunks")
                    .withIndex("by_fileId_chunkIndex", (q: any) => q.eq("fileId", fileId))
                    .collect(),
        );
        const byIndex = new Map<number, { metadata?: object }>(rows.map((row: any) => [row.chunkIndex, row]));

        expect(byIndex.get(1)?.metadata).toStrictEqual({ pageNumber: 4, sectionHeading: "Grazing" });
        expect(byIndex.get(2)?.metadata).toBeUndefined();
    });

    it("returns the page from both legs, and leaves it out for a chunk that has none", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.runMutation(saveChunks, {
                chunks: [{ chunkIndex: 1, content: "Ibex grazing rules.", pageNumber: 4 }],
                fileId,
                userId: USER,
            });
        });

        const vector = await harness.run(
            async (ctx: any) => await ctx.runQuery(getChunksByEmbeddingIds, { embeddingIds: ["emb-1"], knowledgeFileIds: [fileId], userId: USER }),
        );
        const keyword = await harness.run(
            async (ctx: any) => await ctx.runQuery(keywordSearchChunks, { knowledgeFileIds: [fileId], limit: 5, query: "ibex", userId: USER }),
        );

        expect(vector[0]).not.toHaveProperty("pageNumber");
        expect(keyword).toMatchObject([{ content: "Ibex grazing rules.", pageNumber: 4 }]);
    });

    it("keeps the page on a recorded citation through the message row", async () => {
        const messageId = await harness.run(
            async (ctx: any) => await ctx.db.insert("messages", { order: 0, status: "complete", stepOrder: 0, threadId: "thread-1", tool: false }),
        );

        await harness.run(async (ctx: any) => {
            await ctx.runMutation(recordKnowledgeSources, {
                messageId,
                sources: [
                    toKnowledgeSource(
                        { chunkId: "c9", chunkIndex: 3, content: "Ibex grazing rules.", fileId, fileName: "herd.pdf", pageNumber: 7, score: 1 },
                        1,
                    ),
                ],
            });
        });

        const row = await harness.run(async (ctx: any) => await ctx.db.get(messageId));

        expect(readKnowledgeCitation(row.sources[0].providerMetadata)).toMatchObject({ chunkId: "c9", pageNumber: 7 });
    });
});
