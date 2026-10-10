/**
 * Persistent Streaming Library - Internal Queries/Mutations
 *
 * Core streaming operations adapted from the persistent-text-streaming component
 * with extended metadata support for the unified schema.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../../../_generated/dataModel";
import { internalMutation, internalQuery } from "../../../_generated/server";
import type { StreamStatus } from "./schema";
import { streamStatusValidator } from "./schema";

const STREAM_TTL_MS = 20 * 60 * 1000; // 20 minutes

export const createStream = internalMutation
    .input({
        messageId: v.string(),
        streamingConfig: v.object({
            contentType: v.string(),
            customSystemPrompt: v.optional(v.string()),
            enabledFeatures: v.optional(v.array(v.string())),
            imageSize: v.optional(v.string()),
            model: v.string(),
            reasoningEffort: v.optional(v.number()),
            researchDepth: v.optional(v.string()),
            searchMode: v.optional(v.string()),
            statelessMode: v.optional(v.boolean()),
        }),
        threadId: v.string(),
        userId: v.string(),
    })
    .mutation(async ({ args, ctx }) => {
        const now = ctx.now;
        const insertedId = await ctx.db.insert("persistentStreams", {
            expiresAt: now + STREAM_TTL_MS,
            messageId: args.messageId,
            status: "pending",
            streamingConfig: args.streamingConfig,
            threadId: args.threadId,
            userId: args.userId,
        });

        return insertedId as Id<"persistentStreams">;
    });

/**
 * Whether a run may start writing `stream`: only once, and only while nothing
 * has finished it. Pure, so the redelivery rule is testable without a database.
 */
export const canClaimStreamRun = (stream: { runClaimedAt?: number; status: string } | null): boolean =>
    stream !== null && stream.runClaimedAt === undefined && (stream.status === "pending" || stream.status === "streaming");

/**
 * Claim the right to run the agent into `streamId`. The agent run and a
 * tool-approval continuation arrive on the jobs queue, which delivers AT LEAST
 * once — a consumer that times out or loses its ack gets the same message
 * again, possibly while the first delivery is still generating. Only the first
 * claim returns `true`; every redelivery returns `false` and must do nothing,
 * or the user would get a second, interleaved generation in the same stream.
 */
export const claimStreamRun = internalMutation
    .input({ streamId: v.id("persistentStreams") })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const stream = await ctx.db.get(args.streamId);

        if (!stream || !canClaimStreamRun(stream)) {
            return false;
        }

        await ctx.db.patch(args.streamId, { runClaimedAt: ctx.now });

        return true;
    });

export const addChunk = internalMutation
    .input({
        final: v.boolean(),
        reasoning: v.optional(v.string()),
        /** Group chat: this chunk starts a new participant's reply. */
        speaker: v.optional(v.object({ name: v.string(), skillId: v.string() })),
        streamId: v.id("persistentStreams"),
        text: v.string(),
    })
    .mutation(async ({ args, ctx }) => {
        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: args.streamId } });

        if (!stream) {
            throw new LunoraError("NOT_FOUND", "Stream not found");
        }

        if (stream.status !== "pending" && stream.status !== "streaming") {
            throw new LunoraError("CONFLICT", "Stream is not streaming; did it timeout?");
        }

        // The chunk's position: one past the stream's last chunk, read off
        // `by_streamId_seq` in this same mutation. The counter deliberately
        // does NOT live on the stream row: `getActiveStreamForThread` is a live
        // query over `persistentStreams`, and patching the row on every chunk
        // re-ran it for every viewer of the thread on every token. Chunks are
        // read back by `seq`, never by insert order: index ties break on
        // `_creationTime` (ms) and then a RANDOM id, so two chunks written in
        // the same millisecond would come back in either order.
        const last = await ctx.db.persistentChunks.findFirst({ orderBy: [{ seq: "desc" }], where: { streamId: args.streamId } });
        const seq = last ? last.seq + 1 : 0;

        await ctx.db.insert("persistentChunks", {
            reasoning: args.reasoning,
            seq,
            ...(args.speaker && { speaker: args.speaker }),
            streamId: args.streamId,
            text: args.text,
        });

        // The stream row changes only when its status does: on the first chunk
        // and on the final one. Widened: the guard above narrowed
        // `stream.status` to the two live states.
        let status = stream.status as string;

        if (args.final) {
            status = "done";
        } else if (stream.status === "pending") {
            status = "streaming";
        }

        if (status !== stream.status) {
            await ctx.db.patch(args.streamId, { status });
        }
    });

export const setStreamStatus = internalMutation
    .input({
        status: streamStatusValidator,
        streamId: v.id("persistentStreams"),
    })
    .mutation(async ({ args, ctx }) => {
        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: args.streamId } });

        if (!stream) {
            throw new LunoraError("NOT_FOUND", "Stream not found");
        }

        if (stream.status !== "pending" && stream.status !== "streaming") {
            console.log("Stream is already finalized; ignoring status change", stream);

            return;
        }

        await ctx.db.patch(args.streamId, {
            status: args.status,
        });
    });

export const getStreamStatus = internalQuery
    .input({
        streamId: v.id("persistentStreams"),
    })
    .output(v.from(streamStatusValidator))
    .query(async ({ args, ctx }) => {
        const stream = await ctx.db.get(args.streamId);

        return (stream?.status ?? "error") as StreamStatus;
    });

export const getStreamText = internalQuery
    .input({
        streamId: v.id("persistentStreams"),
    })
    .output(
        v.object({
            messageId: v.optional(v.string()),
            reasoning: v.string(), // Concatenated reasoning from all chunks
            /** Group chat: who is speaking. `text`/`reasoning` then cover only their reply. */
            speaker: v.optional(v.object({ name: v.string(), skillId: v.string() })),
            status: streamStatusValidator,
            streamingConfig: v.optional(
                v.object({
                    contentType: v.string(),
                    customSystemPrompt: v.optional(v.string()),
                    enabledFeatures: v.optional(v.array(v.string())),
                    imageSize: v.optional(v.string()),
                    model: v.string(),
                    reasoningEffort: v.optional(v.number()),
                    researchDepth: v.optional(v.string()),
                    searchMode: v.optional(v.string()),
                    statelessMode: v.optional(v.boolean()),
                }),
            ),
            text: v.string(),
            threadId: v.optional(v.string()),
            userId: v.optional(v.string()),
        }),
    )
    .query(async ({ args, ctx }) => {
        const stream = await ctx.db.get(args.streamId);

        if (!stream) {
            throw new LunoraError("NOT_FOUND", "Stream not found");
        }

        let text = "";
        let reasoning = "";
        let speaker: { name: string; skillId: string } | undefined;

        if (stream.status !== "pending") {
            const { page: allChunks } = await ctx.db.persistentChunks.findMany({
                orderBy: [{ seq: "asc" }],
                where: { streamId: args.streamId },
            });
            // In a group turn, earlier participants' replies are already saved
            // messages; only the current speaker's text is still "streaming".
            const lastMarker = allChunks.findLastIndex((chunk) => chunk.speaker);
            const chunks = lastMarker === -1 ? allChunks : allChunks.slice(lastMarker);

            speaker = lastMarker === -1 ? undefined : (allChunks[lastMarker]?.speaker ?? undefined);
            text = chunks.map((chunk) => chunk.text).join("");
            reasoning = chunks.map((chunk) => chunk.reasoning || "").join("");
        }

        return {
            messageId: stream.messageId,
            reasoning,
            ...(speaker && { speaker }),
            status: stream.status as StreamStatus,
            streamingConfig: stream.streamingConfig,
            text,
            threadId: stream.threadId,
            userId: stream.userId,
        };
    });

export const getChunksAfter = internalQuery
    .input({
        afterIndex: v.number(),
        streamId: v.id("persistentStreams"),
    })
    .output(
        v.object({
            chunks: v.array(
                v.object({
                    reasoning: v.optional(v.string()),
                    speaker: v.optional(v.object({ name: v.string(), skillId: v.string() })),
                    text: v.string(),
                }),
            ),
            /**
             * Read in the SAME query as the chunks, so the two agree: a stream
             * seen `done` has its final chunk in `chunks`. Two separate queries
             * could see the final chunk's mutation land between them and report
             * `done` without it — the relay then closed one chunk short.
             */
            status: streamStatusValidator,
            /** Position after the last chunk returned — or the cursor itself when nothing is new. */
            totalChunks: v.number(),
        }),
    )
    .query(async ({ args: { afterIndex, streamId }, ctx }) => {
        // One indexed row, not an un-hinted `db.get` (which probes every table).
        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: streamId } });
        const status = (stream?.status ?? "error") as StreamStatus;
        const toChunk = (c: { reasoning?: string | null; speaker?: { name: string; skillId: string } | null; text: string }) => {
            return { reasoning: c.reasoning ?? undefined, ...(c.speaker && { speaker: c.speaker }), text: c.text };
        };

        // Only the chunks past the cursor, in order. With nothing new this is
        // an empty index range: the poll reads the stream row and no chunk.
        const { page } = await ctx.db.persistentChunks.findMany({
            orderBy: [{ seq: "asc" }],
            where: { seq: { gte: afterIndex }, streamId },
        });
        const lastChunk = page.at(-1);

        return { chunks: page.map((chunk) => toChunk(chunk)), status, totalChunks: lastChunk ? lastChunk.seq + 1 : afterIndex };
    });

const BATCH_SIZE = 100;

export const cleanupExpiredStreams = internalMutation.input({}).mutation(async ({ ctx }) => {
    const now = ctx.now;
    // Use by_expiresAt index to efficiently find expired streams
    const expiredStreams = await ctx.db
        .query("persistentStreams")
        .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
        .take(BATCH_SIZE);

    for (const stream of expiredStreams) {
        if (!(stream.status === "pending" || stream.status === "streaming")) {
            continue;
        }

        console.log("Cleaning up expired stream", stream._id);
        await ctx.db.patch(stream._id, {
            status: "timeout",
        });
    }
});
