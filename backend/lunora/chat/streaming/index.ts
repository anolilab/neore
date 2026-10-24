import { LunoraError, v } from "lunorash/server";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { internalMutation, internalQuery } from "../../_generated/server";
import { patchThread } from "../../agent/table-writes";
import { resolveThreadReadAccess } from "../../agent/thread-read-access";
import { publicThread } from "../../agent/threads";
import { vThreadDoc } from "../../agent/validators";
import { optionalAuthQuery } from "../../lib/crpc";
import { MAX_LENGTH } from "../../lib/validators";
import { throwThreadLocked } from "../../lib/thread-lock";
import { deliveredSteerIds, type SteerEntry } from "../lib/steer-queue";
import { lockedAfterCreation, streamLockedAfterStart } from "../lib/thread-gate";

/**
 * Persistent Text Streaming Helper
 *
 * Uses local persistent-text-streaming implementation for instant real-time streaming
 * while maintaining persistence with the agent for message history.
 *
 * This file provides a simplified wrapper around the streaming API.
 * Stream metadata (messageId, userId, threadId, streamingConfig) is now stored
 * directly in the persistentStreams table for optimal query performance.
 */
import type { StreamId } from "./persistent";
import { PersistentTextStreaming, streamStatusValidator } from "./persistent";
import { parentKeyOf } from "../../lib/rls/scope";

// Streaming config validator - matches ./persistent/schema.ts
const vStreamingConfig = v.object({
    contentType: v.string(),
    customSystemPrompt: v.optional(v.string()),
    enabledFeatures: v.optional(v.array(v.string())),
    imageSize: v.optional(v.string()),
    model: v.string(),
    reasoningEffort: v.optional(v.number()),
    searchMode: v.optional(v.string()),
    statelessMode: v.optional(v.boolean()),
});

// Create the PersistentTextStreaming instance with local API
export const persistentTextStreaming = new PersistentTextStreaming({
    lib: internal.chat.streaming.persistent.library,
});

/**
 * Query to get stream body - required by useStream hook on client
 */
const vStreamBody = v.object({
    reasoning: v.string(),
    /** Group chat: the participant speaking; `text`/`reasoning` are theirs only. */
    speaker: v.optional(v.object({ name: v.string(), skillId: v.string() })),
    // The canonical union, not a copy of it — an inline duplicate here could
    // drift from the one the table and the writer use.
    status: streamStatusValidator,
    text: v.string(),
});

// `.output()` is declared, not merely annotated on the handler.
//
// Left to inference this generated `import("./persistent").StreamBody` into
// `_generated/api.ts` — a specifier resolved against THIS file's directory, which
// means nothing from `_generated/`. It resolved to
// an empty type, and `streaming-placeholder.tsx` in the web app had to re-declare
// the shape locally to work around it.
//
// Until now only the RETURN ANNOTATION was here, while the comment claimed the
// output was declared. The annotation alone does fix codegen (a declared
// `.output()` is authoritative for the generated type), but it buys no runtime
// gating. Declaring it is safe here specifically
// because `StreamBody` is exactly these fields — `v.object` STRIPS unknown
// keys, so a validator narrower than the value silently drops data.
//
// Access is the THREAD's (`resolveThreadReadAccess`): owner or live grantee get
// everything; a viewer of a live public thread gets the text but not the
// reasoning, which the public share projection never shows; anyone else gets
// NOT_FOUND, the same answer as a missing stream. It used to be a bare
// `publicQuery` keyed by the stream id alone.
export const getStreamBody = optionalAuthQuery
    .input({
        streamId: v.id("persistentStreams"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(vStreamBody)
    .query(async ({ args: input, ctx }) => {
        // Decided on the stream's THREAD (which admits it), so the stream row is
        // found by its thread id first — row-level security hides it until then.
        const threadId = await parentKeyOf(ctx, input.streamId, "threadId");
        const access = threadId ? await resolveThreadReadAccess(ctx, threadId as Id<"threads">, ctx.user?.userId, input.unlockProof) : null;

        if (!access) {
            throw new LunoraError("NOT_FOUND", "Stream not found");
        }

        if (access.kind === "locked") {
            return throwThreadLocked();
        }

        const body = await persistentTextStreaming.getStreamBody(ctx, input.streamId as StreamId);

        return access.kind === "full" ? body : { ...body, reasoning: "" };
    });

export const createStreamWithMessage = internalMutation
    .input({
        messageId: v.string(),
        streamingConfig: vStreamingConfig,
        threadId: v.string(),
        userId: v.string(),
    })
    // `StreamId` is a branded string. Declaring the output keeps codegen from
    // inferring the brand into `api.ts`, where it landed as a bare name with no
    // import.
    .output(v.string())
    .mutation(async ({ args: { messageId, streamingConfig, threadId, userId }, ctx: context }) => {
        const streamId = await persistentTextStreaming.createStream(context, {
            messageId,
            streamingConfig,
            threadId,
            userId,
        });

        // The thread shows as running from the moment its stream exists. This
        // was a scheduled `updateThread` that `/chat/start` awaited after
        // enqueueing the run — one more round trip before the client could
        // start streaming, and, on the one-at-a-time scheduler, able to land
        // AFTER a short run had already set the thread back to `active`.
        const thread = await context.db.get(threadId as Id<"threads">);

        if (thread) {
            await patchThread(context.db, thread._id, { status: "running", updatedAt: context.now });
        }

        return streamId;
    });

/**
 * Query to detect active stream for a thread
 * Returns the streamId if there's an active stream, null otherwise
 * Used by the client to show streaming placeholder reactively.
 *
 * LIVE, so it re-runs whenever `persistentStreams` is written. Its answer only
 * changes when a stream starts or ends, and the stream row is written only
 * then (`addChunk` keeps the chunk position on the chunks, not on this row) —
 * keep it that way, or every token re-runs this for every viewer.
 */
export const getActiveStreamForThread = optionalAuthQuery
    .input({
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(
        v.union(
            v.object({
                /**
                 * Steering (`chat/steering.ts`): the messages the run has taken, for
                 * the composer to retire their chips. The run's own user only.
                 */
                deliveredSteerIds: v.optional(v.array(v.string())),
                streamId: v.id("persistentStreams"),
            }),
            v.null(),
        ),
    )
    .query(async ({ args: input, ctx }) => {
        const { threadId, unlockProof } = input;

        // Same rule as `getStreamBody`, which this hands its stream id to. The bare
        // `isPublic` test it replaces also admitted deleted and temporary threads.
        // A locked chat answers nothing here, rather than an error on a live query.
        const access = await resolveThreadReadAccess(ctx, threadId, ctx.user?.userId, unlockProof);

        if (!access || access.kind === "locked") {
            return null;
        }

        // The ORM facade puts the status test in SQL; the legacy `.filter()`
        // read every stream the thread ever had (one per turn) to find one.
        const stream = await ctx.db.persistentStreams.findFirst({
            orderBy: [{ _creationTime: "asc" }],
            where: { status: { in: ["pending", "streaming"] }, threadId },
        });

        if (!stream) {
            return null;
        }

        const delivered = stream.userId === ctx.user?.userId ? deliveredSteerIds(stream.steers as SteerEntry[] | undefined) : [];

        return delivered.length > 0 ? { deliveredSteerIds: delivered, streamId: stream._id } : { streamId: stream._id };
    });

/**
 * The thread a background run on this stream may write into, or null. Full
 * access only (owner or live grantee), as before. A locked thread is admitted
 * only when it was not locked after the stream row was created: that row is
 * written only by a request that passed the lock gate, and a background run has
 * no proof of its own.
 */
export const streamRunThreadHandler = async (ctx: QueryCtx, args: { streamId: Id<"persistentStreams">; userId: string }) => {
    const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: args.streamId } });

    if (!stream) {
        return null;
    }

    const access = await resolveThreadReadAccess(ctx, stream.threadId as Id<"threads">, args.userId);

    if (!access || access.thread.deleted) {
        return null;
    }

    if (access.kind === "full") {
        return publicThread(access.thread);
    }

    if (access.kind === "locked" && !lockedAfterCreation(access.thread, stream._creationTime)) {
        return publicThread(access.thread);
    }

    return null;
};

export const streamRunThread = internalQuery
    .input({ streamId: v.id("persistentStreams"), userId: v.string() })
    .output(v.from(v.union(vThreadDoc, v.null())))
    .query(async ({ args, ctx }) => await streamRunThreadHandler(ctx, args));

/**
 * True when the stream's thread was locked after the stream was created. The
 * `/chat/chunks` poll carries no proof, so its refusal rests on this alone.
 * A missing stream answers true: nothing is read from it.
 */
export const streamLockedSinceStartHandler = async (ctx: QueryCtx, args: { streamId: Id<"persistentStreams"> }): Promise<boolean> => {
    const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: args.streamId } });

    return await streamLockedAfterStart(ctx, stream);
};
