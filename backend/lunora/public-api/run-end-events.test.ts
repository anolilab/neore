/**
 * A run's end writes exactly one event into the owner's Events log, in the same mutation as the chunk that ends the stream.
 * Runs against the real schema: the stream row, the thread, and `addChunk`.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { closeGroupTurnStream } from "../chat/group/run";
import { cleanupExpiredStreams } from "../chat/streaming/persistent/crons";
import { endHostStream } from "../chat/streaming/persistent/host";
import { addChunk, setStreamStatus } from "../chat/streaming/persistent/library";
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
    const OLD = Date.now() - 8 * 24 * 60 * 60 * 1000;

    /** `count` events of `OWNER`'s log written `OLD`, numbered from 1, and the watermark the recorder would have left. */
    const seedOldLog = async (count: number): Promise<void> => {
        await harness.run(async (ctx: any) => {
            for (let seq = 1; seq <= count; seq += 1) {
                await ctx.db.insert("mcpEvents", {
                    createdAt: OLD,
                    data: "{}",
                    eventId: `run:old-${seq}`,
                    name: "run.completed",
                    seq,
                    timestamp: OLD,
                    userId: OWNER,
                });
            }

            await ctx.db.insert("mcpEventWatermarks", { seq: count, userId: OWNER });
        });
    };

    it("drops every expired event, the highest included, and the next event carries on from the watermark", async () => {
        await seedOldLog(3);

        const outcome = await harness.run(async (ctx: any) => await ctx.runMutation(pruneMcpEvents, {}));

        expect(outcome).toStrictEqual({ hasMore: false, removed: 3 });
        expect(await eventsOf()).toStrictEqual([]);

        await finish({ runEnd: "succeeded" });

        const events = await eventsOf();

        expect(events.map((event) => event.seq)).toStrictEqual([4]);
    });

    it("takes a backlog longer than one batch over several calls, and says hasMore until it is drained", async () => {
        await seedOldLog(205);

        const first = await harness.run(async (ctx: any) => await ctx.runMutation(pruneMcpEvents, {}));
        const second = await harness.run(async (ctx: any) => await ctx.runMutation(pruneMcpEvents, {}));

        expect(first).toStrictEqual({ hasMore: true, removed: 200 });
        expect(second).toStrictEqual({ hasMore: false, removed: 5 });
        expect(await eventsOf()).toStrictEqual([]);
    });

    it("keeps events inside the window", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("mcpEvents", {
                createdAt: Date.now(),
                data: "{}",
                eventId: "run:recent",
                name: "run.completed",
                seq: 1,
                timestamp: Date.now(),
                userId: OWNER,
            });
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(pruneMcpEvents, {}));

        const events = await eventsOf();

        expect(events.map((event) => event.eventId)).toStrictEqual(["run:recent"]);
    });
});

describe("a group turn's end in the Events log", () => {
    // The harness runs function references, not the `internal.*` reference the group runner passes. `closeGroupTurnStream` calls only
    // `addChunk`, so the wrapper runs that function with the same args.
    const closeWith = async (runEnd: "succeeded" | "failed" | undefined): Promise<void> =>
        await harness.run(
            async (ctx: any) =>
                await closeGroupTurnStream(
                    { runMutation: async (_ref: unknown, args: unknown) => await ctx.runMutation(addChunk, args) } as never,
                    { streamId },
                    runEnd,
                ),
        );
    const groupEnd = async (): Promise<void> => await closeWith("succeeded");

    it("writes one run.completed when the group turn finishes normally", async () => {
        await groupEnd();

        const events = await eventsOf();

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ eventId: `run:${streamId}`, name: "run.completed", seq: 1, userId: OWNER });
        expect(JSON.parse(events[0]!.data)).toMatchObject({ outcome: "succeeded", threadId });
    });

    it("closes with the succeeded final chunk the repeated-call guard's turn also closes with", async () => {
        // The guard ends a speaker's reply, then the turn breaks out of the speaker loop into the same closing call, so one chunk is what it writes.
        const chunks: unknown[] = [];
        const recording = {
            runMutation: async (_ref: unknown, args: unknown) => {
                chunks.push(args);
            },
        };

        await closeGroupTurnStream(recording as never, { streamId }, "succeeded");

        expect(chunks).toStrictEqual([{ final: true, runEnd: "succeeded", streamId, text: "" }]);
    });

    it("writes no run event when the group Stop ends the turn, and its closing chunk carries no runEnd", async () => {
        const chunks: unknown[] = [];
        const recording = {
            runMutation: async (_ref: unknown, args: unknown) => {
                chunks.push(args);
            },
        };

        await closeGroupTurnStream(recording as never, { streamId }, undefined);

        expect(chunks).toStrictEqual([{ final: true, streamId, text: "" }]);
        await closeWith(undefined);
        expect(await eventsOf()).toStrictEqual([]);
    });

    it("writes one run.failed when the daily quota ends the group turn early", async () => {
        await closeWith("failed");

        const events = await eventsOf();

        expect(events.map((event) => event.name)).toStrictEqual(["run.failed"]);
        expect(JSON.parse(events[0]!.data)).toMatchObject({ outcome: "failed", threadId });
    });

    it("writes one run.completed when the closing chunk is redelivered, because the stream refuses the second end", async () => {
        await groupEnd();
        await expect(groupEnd()).rejects.toThrow();

        expect(await eventsOf()).toHaveLength(1);
    });
});

describe("a coding-agent turn's end in the Events log", () => {
    const hostTurn = async (): Promise<string> =>
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    hostState: "running",
                    messageId: "host-prompt",
                    producer: "host",
                    status: "streaming",
                    streamingConfig: { contentType: "text", model: "test-model" },
                    threadId,
                    userId: OWNER,
                }),
        );

    const endTurn = async (id: string, end: { reason: string; status: string }): Promise<void> =>
        await harness.run(async (ctx: any) => {
            const stream = await ctx.db.get("persistentStreams", id);

            await endHostStream(ctx, stream, end as never, Date.now());
        });

    it("writes one run.completed when the host turn finishes", async () => {
        const id = await hostTurn();

        await endTurn(id, { reason: "finished", status: "done" });

        const events = await eventsOf();

        expect(events.map((event) => [event.eventId, event.name])).toStrictEqual([[`run:${id}`, "run.completed"]]);
    });

    it("writes one run.failed when the host turn times out", async () => {
        const id = await hostTurn();

        await endTurn(id, { reason: "timeout", status: "timeout" });

        const events = await eventsOf();

        expect(events.map((event) => event.name)).toStrictEqual(["run.failed"]);
    });

    it("writes nothing when the host turn is stopped", async () => {
        const id = await hostTurn();

        await endTurn(id, { reason: "stopped", status: "done" });

        expect(await eventsOf()).toStrictEqual([]);
    });

    it("writes nothing when the computer cancels the turn, which is a stop from its side", async () => {
        const id = await hostTurn();

        await endTurn(id, { reason: "cancelled", status: "done" });

        expect(await eventsOf()).toStrictEqual([]);
    });
});

describe("a run whose thread has no owner in the Events log", () => {
    it("records the end for the run's starter, when the thread's owner is gone", async () => {
        const orphanThread = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Orphan" }));
        const orphanStream = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    messageId: "orphan-prompt",
                    status: "streaming",
                    streamingConfig: { contentType: "text", model: "test-model" },
                    threadId: orphanThread,
                    userId: OWNER,
                }),
        );

        await harness.run(async (ctx: any) => await ctx.runMutation(addChunk, { final: true, runEnd: "succeeded", streamId: orphanStream, text: "Done." }));

        const events = await eventsOf();

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ eventId: `run:${orphanStream}`, name: "run.completed", userId: OWNER });
    });
});

describe("a run whose thread row was deleted in the Events log", () => {
    it("records nothing, since the log is not reachable from the shard the run ends on", async () => {
        const gone = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Gone", userId: OWNER }));
        const goneStream = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    messageId: "gone-prompt",
                    status: "streaming",
                    streamingConfig: { contentType: "text", model: "test-model" },
                    threadId: gone,
                    userId: "collaborator",
                }),
        );

        await harness.run(async (ctx: any) => await ctx.db.delete("threads", gone));
        await harness.run(async (ctx: any) => await ctx.runMutation(addChunk, { final: true, runEnd: "succeeded", streamId: goneStream, text: "Done." }));

        expect(await eventsOf()).toStrictEqual([]);
    });
});

describe("a run that ends without its own final chunk in the Events log", () => {
    it("writes one run.failed when a live stream is set to error", async () => {
        await harness.run(async (ctx: any) => await ctx.runMutation(setStreamStatus, { status: "error", streamId }));

        const events = await eventsOf();

        expect(events.map((event) => event.name)).toStrictEqual(["run.failed"]);
        expect(events[0]).toMatchObject({ eventId: `run:${streamId}`, userId: OWNER });
    });

    it("writes one run.failed for an expired stream the sweep times out", async () => {
        const expiredId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() - 60_000,
                    messageId: "prompt-expired",
                    status: "streaming",
                    streamingConfig: { contentType: "text", model: "test-model" },
                    threadId,
                    userId: OWNER,
                }),
        );

        await harness.run(async (ctx: any) => await ctx.runMutation(cleanupExpiredStreams, {}));

        const events = await eventsOf();

        expect(events.map((event) => event.eventId)).toStrictEqual([`run:${expiredId}`]);
        expect(events[0]!.name).toBe("run.failed");
    });
});
