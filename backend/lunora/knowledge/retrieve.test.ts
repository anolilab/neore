/**
 * Knowledge search carries each chunk's file id through both legs and the RRF
 * fusion, next to the fields its callers already read (the chat tool, the
 * agent-run context and the public API's `searchKnowledge`, whose output
 * validator keeps its narrower shape). Eval runs match expected sources by it.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { getChunksByEmbeddingIds, keywordSearchChunks } from "./functions";
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
