/**
 * What a `/chat/chunks` poll and a chunk write cost the database. A poll runs
 * up to ten times a second per streaming reply (`http-api.ts`), so it must read
 * one row when nothing is new and only the new chunks when something is.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { measureDb } from "../../../../test/db-cost";
import schema from "../../../schema";
import { addChunk, createStream, getChunksAfter, getStreamText } from "./library";

const CHUNKS = 60;

const setup = async () => {
    const harness = lunoraTest(schema as never);
    const streamId = (await harness.run(
        async (context: any) =>
            await context.runMutation(createStream, {
                messageId: "m1",
                streamingConfig: { contentType: "text", model: "m" },
                threadId: "t1",
                userId: "u1",
            }),
    )) as string;

    for (let index = 0; index < CHUNKS; index += 1) {
        await harness.run(async (context: any) => await context.runMutation(addChunk, { final: false, streamId, text: `c${String(index)} ` }));
    }

    return { harness, streamId };
};

const poll = async (harness: ReturnType<typeof lunoraTest>, streamId: string, afterIndex: number) =>
    await measureDb(
        async () =>
            (await harness.run(async (context: any) => await context.runQuery(getChunksAfter, { afterIndex, streamId }))) as {
                chunks: { text: string }[];
                status: string;
                totalChunks: number;
            },
    );

describe("persistent stream cost", () => {
    it("answers a poll with nothing new from the stream row alone", async () => {
        const { harness, streamId } = await setup();

        try {
            const { cost, result } = await poll(harness, streamId, CHUNKS);

            expect(result).toStrictEqual({ chunks: [], status: "streaming", totalChunks: CHUNKS });
            // The stream row, plus an index range past the cursor that is empty.
            expect(cost.statements, JSON.stringify(cost.byTable)).toBe(2);
            expect(cost.rowsRead).toBe(1);
        } finally {
            harness.close();
        }
    });

    it("reads only the chunks past the cursor, in order", async () => {
        const { harness, streamId } = await setup();

        try {
            const { cost, result } = await poll(harness, streamId, CHUNKS - 3);

            expect(result.chunks.map((chunk) => chunk.text)).toStrictEqual([`c${String(CHUNKS - 3)} `, `c${String(CHUNKS - 2)} `, `c${String(CHUNKS - 1)} `]);
            expect(result.totalChunks).toBe(CHUNKS);
            expect(cost.statements, JSON.stringify(cost.byTable)).toBe(2);
            // The stream row plus the three new chunks — not all sixty.
            expect(cost.rowsRead).toBe(1 + 3);
        } finally {
            harness.close();
        }
    });

    it("writes the stream row only when its status changes, never per chunk", async () => {
        const { harness, streamId } = await setup();

        try {
            // `getActiveStreamForThread` is a LIVE query over `persistentStreams`;
            // a write to the row on every chunk re-ran it for every viewer.
            const { cost } = await measureDb(
                async () => await harness.run(async (context: any) => await context.runMutation(addChunk, { final: false, streamId, text: "more" })),
            );
            const streamStatements = cost.byTable.persistentStreams ?? 0;

            // The existence/status read, and nothing else on that table.
            expect(streamStatements, JSON.stringify(cost.byTable)).toBe(1);

            const { cost: finalCost } = await measureDb(
                async () => await harness.run(async (context: any) => await context.runMutation(addChunk, { final: true, streamId, text: "end" })),
            );

            expect(finalCost.byTable.persistentStreams ?? 0, JSON.stringify(finalCost.byTable)).toBeGreaterThan(streamStatements);
        } finally {
            harness.close();
        }
    });

    it("keeps the count in step with the chunks and finishes the stream on the final one", async () => {
        const { harness, streamId } = await setup();

        try {
            await harness.run(async (context: any) => await context.runMutation(addChunk, { final: true, streamId, text: "end" }));

            const { result } = await poll(harness, streamId, 0);

            expect(result.status).toBe("done");
            expect(result.totalChunks).toBe(CHUNKS + 1);
            expect(result.chunks.map((chunk) => chunk.text).join("")).toBe(`${Array.from({ length: CHUNKS }, (_, index) => `c${String(index)} `).join("")}end`);
        } finally {
            harness.close();
        }
    });

    it("returns chunks in write order even when several land in the same millisecond", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const streamId = (await harness.run(
                async (context: any) =>
                    await context.runMutation(createStream, {
                        messageId: "m1",
                        streamingConfig: { contentType: "text", model: "m" },
                        threadId: "t1",
                        userId: "u1",
                    }),
            )) as string;
            const texts = Array.from({ length: 30 }, (_, index) => `${String(index)},`);

            // One mutation: every chunk shares a `_creationTime`, so only `seq`
            // orders them — index ties otherwise break on a random id.
            await harness.run(async (context: any) => {
                for (const text of texts) {
                    await context.runMutation(addChunk, { final: false, streamId, text });
                }
            });

            const { result } = await poll(harness, streamId, 1);

            expect(result.chunks.map((chunk) => chunk.text)).toStrictEqual(texts.slice(1));
            expect(result.totalChunks).toBe(texts.length);

            const streamed = (await harness.run(async (context: any) => await context.runQuery(getStreamText, { streamId }))) as { text: string };

            expect(streamed.text).toBe(texts.join(""));
        } finally {
            harness.close();
        }
    });
});
