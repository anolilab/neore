/**
 * The stream read that feeds a live turn's activity takes every chunk of the stream, not a first page: a plan or a tool event
 * written after the first page of a long turn must still be seen.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import schema from "../../../schema";

describe("reading a stream's chunks", () => {
    it("returns every chunk of a long stream, in order, without a first page", async () => {
        const harness = lunoraTest(schema as never);
        const streamId = await harness.run(
            async (context: any) =>
                await context.db.insert("persistentStreams", {
                    producer: "host",
                    status: "streaming",
                    threadId: "thread-1",
                }),
        );

        await harness.run(async (context: any) => {
            for (let seq = 0; seq < 60; seq += 1) {
                await context.db.insert("persistentChunks", { seq, streamId, text: "" });
            }
        });

        const { page } = await harness.run(
            async (context: any) =>
                await context.db.persistentChunks.findMany({
                    orderBy: [{ seq: "asc" }],
                    where: { streamId },
                }),
        );

        expect(page).toHaveLength(60);
        expect(page.at(-1)?.seq).toBe(59);
    });
});
