/**
 * A run's end writes exactly one event into the owner's Events log, in the same mutation as the chunk that ends the stream.
 * Runs against the real schema: the stream row, the thread, and `addChunk`.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { addChunk } from "../chat/streaming/persistent/library";
import schema from "../schema";
import { pruneMcpEvents } from "./events";

const OWNER = "owner-user";

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;
let streamId: string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }));
    streamId = await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("persistentStreams", {
                expiresAt: Date.now() + 60_000,
                messageId: "prompt",
                status: "streaming",
                streamingConfig: { contentType: "text", model: "test-model" },
                threadId,
                userId: OWNER,
            }),
    );
});

const finish = async (fields: Record<string, unknown>): Promise<void> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(addChunk, { final: true, streamId, text: "Done.", ...fields }));

const eventsOf = async (): Promise<{ data: string; eventId: string; name: string; seq: number; userId: string }[]> =>
    await harness.run(async (ctx: any) => await ctx.db.query("mcpEvents").collect());

describe("a run's end in the Events log", () => {
    it("writes one run.completed for a run that finished normally, in the chunk that ends it", async () => {
        await finish({ runEnd: "succeeded" });

        const events = await eventsOf();

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ eventId: `run:${streamId}`, name: "run.completed", seq: 1, userId: OWNER });
        expect(JSON.parse(events[0]!.data)).toMatchObject({ outcome: "succeeded", threadId });
    });

    it("writes one run.failed for a run that ended with an error", async () => {
        await finish({ runEnd: "failed", text: "\n\nError: boom" });

        const events = await eventsOf();

        expect(events.map((event) => event.name)).toStrictEqual(["run.failed"]);
    });

    it("writes nothing for a chunk that does not end the run, or a paused one that carries no runEnd", async () => {
        await harness.run(async (ctx: any) => await ctx.runMutation(addChunk, { final: false, streamId, text: "Reading." }));
        await harness.run(async (ctx: any) => await ctx.runMutation(addChunk, { final: true, streamId, text: "Paused." }));

        expect(await eventsOf()).toStrictEqual([]);
    });

    it("writes exactly one event: a redelivered end is refused by the stream, so nothing is written twice", async () => {
        await finish({ runEnd: "succeeded" });
        await expect(finish({ runEnd: "succeeded" })).rejects.toThrow();

        expect(await eventsOf()).toHaveLength(1);
    });
});

describe("retention of the Events log", () => {
    it("drops events past the window and keeps the newest row, so the sequence never restarts", async () => {
        const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
        const row = (seq: number, createdAt: number) => {
            return {
                createdAt,
                data: "{}",
                eventId: `run:old-${seq}`,
                name: "run.completed",
                seq,
                timestamp: createdAt,
                userId: OWNER,
            };
        };

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("mcpEvents", row(1, old));
            await ctx.db.insert("mcpEvents", row(2, old));
            await ctx.db.insert("mcpEvents", row(3, old));
        });

        const outcome = await harness.run(async (ctx: any) => await ctx.runMutation(pruneMcpEvents, {}));

        expect(outcome).toMatchObject({ removed: 2 });
        const events = await eventsOf();

        expect(events.map((event) => event.seq)).toStrictEqual([3]);
    });
});
