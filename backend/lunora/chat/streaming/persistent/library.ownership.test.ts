/**
 * `getChunksAfter` with the `userId`/`threadId` `/chat/chunks` passes: the route crosses shards as the
 * system, so the query itself must refuse a stream that is not the named user's and thread's.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import schema from "../../../schema";
import { addChunk, createStream, getChunksAfter } from "./library";

describe("getChunksAfter ownership", () => {
    it("answers a stream of another user or thread as a missing one", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const { streamId, threadId } = (await harness.run(async (context: any) => {
                const thread = await context.db.insert("threads", { model: "m", status: "running", title: "t", userId: "owner" });
                const stream = await context.runMutation(createStream, {
                    messageId: "m1",
                    streamingConfig: { contentType: "text", model: "m" },
                    threadId: thread,
                    userId: "owner",
                });

                await context.runMutation(addChunk, { final: false, streamId: stream, text: "secret" });

                return { streamId: stream, threadId: thread };
            })) as { streamId: string; threadId: string };
            const read = async (extra: Record<string, string>) =>
                (await harness.run(async (context: any) => await context.runQuery(getChunksAfter, { afterIndex: 0, streamId, ...extra }))) as {
                    chunks: unknown[];
                    status: string;
                };

            const own = await read({ threadId, userId: "owner" });

            expect(own.chunks).toHaveLength(1);
            expect(await read({ threadId, userId: "someone-else" })).toMatchObject({ chunks: [], status: "error" });
            expect(await read({ threadId: "another-thread", userId: "owner" })).toMatchObject({ chunks: [], status: "error" });
        } finally {
            harness.close();
        }
    });
});
