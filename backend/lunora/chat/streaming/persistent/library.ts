/**
 * Persistent Streaming Library - Internal Queries/Mutations
 *
 * Core streaming operations adapted from the persistent-text-streaming component
 * with extended metadata support for the unified schema.
 */
import { LunoraError, v } from "lunorash/server";

import { syncActiveAgent } from "../../../agent/agent-switch";
import { addMessagesHandler, deleteMessage } from "../../../agent/messages";
import { parentOf } from "../../../agent/branch-rows";
import { patchThread } from "../../../agent/table-writes";
import { internal } from "../../../_generated/internal";
import type { Doc, Id } from "../../../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../../../_generated/server";
import { patchRow } from "../../../lib/patch";
import { streamLockedAfterStart } from "../../lib/thread-gate";
import { MAX_LENGTH } from "../../../lib/validators";
import { latestSteerMessageId, latestSteerPendingId, type SteerEntry, withoutQueuedText } from "../../lib/steer-queue";
import type { StreamStatus } from "./schema";
import { streamStatusValidator } from "./schema";

const STREAM_TTL_MS = 20 * 60 * 1000; // 20 minutes
const LIVE_STREAM_PAGE = 50;

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
        const { now } = ctx;
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
        /** Steering: the reply continues below a message the user sent into it (`chat/steering.ts`). */
        restart: v.optional(v.boolean()),
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
            ...(args.restart && { restart: true }),
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
            // The run is over: a steer it never took keeps no text on the row (`withoutQueuedText`).
            const steers = args.final ? withoutQueuedText(stream.steers as SteerEntry[] | undefined) : undefined;

            await ctx.db.patch(args.streamId, { status, ...(steers && { steers }) });
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

        // Any status past the live ones ends the run: a steer it never took keeps no text on the row.
        const steers = args.status === "pending" || args.status === "streaming" ? undefined : withoutQueuedText(stream.steers as SteerEntry[] | undefined);

        await ctx.db.patch(args.streamId, {
            status: args.status,
            ...(steers && { steers }),
        });
    });

/**
 * The sidebar's stop for a persistent reply. Each live stream of the thread ends
 * `done` with the chunks it already has, so the run's next chunk write is refused
 * (`CONFLICT`); the run then saves what it has (`finishStoppedReply`). The thread
 * leaves `running` the way a legacy abort does: `abort`, then back to `active` a
 * second later. Returns whether anything was stopped.
 *
 * The run learns of the stop at its next chunk write, or, while a tool step keeps it quiet, when `pipeToPersistentChunks`
 * polls the stream (`STOP_POLL_MS`) and at each finished step. Either way `endStoppedRun` then aborts the model call
 * and the signal its tools get. A tool that ignores that signal still runs to its end, but no further step starts.
 */
export const stopActiveForThread = internalMutation
    .input({ messageId: v.optional(v.string().max(MAX_LENGTH.id)), threadId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        // Read the live streams in pages (a thread has one or two; the bound is for a runaway one), then stop them.
        const live: Doc<"persistentStreams">[] = [];
        let cursor: string | undefined;

        do {
            const page = await ctx.db.persistentStreams.findMany({
                cursor,
                limit: LIVE_STREAM_PAGE,
                where: { status: { in: ["pending", "streaming"] }, threadId: args.threadId },
            });

            live.push(...page.page);
            cursor = page.isDone ? undefined : (page.continueCursor ?? undefined);
        } while (cursor);

        // A stop that names a prompt ends that prompt's reply only. When no live stream carries the id (a
        // placeholder key, or a reply started from another row), it falls back to the whole thread.
        const named = args.messageId === undefined ? [] : live.filter((stream) => stream.messageId === args.messageId);
        const streams = named.length > 0 ? named : live;

        for (const stream of streams) {
            const steers = withoutQueuedText(stream.steers as SteerEntry[] | undefined);

            await ctx.db.patch(stream._id, { status: "done", ...(steers && { steers }) });
        }

        // The thread leaves `running` only when no live reply is left to keep running.
        if (streams.length > 0 && streams.length === live.length) {
            const threadId = args.threadId as Id<"threads">;

            await patchThread(ctx.db, threadId, { status: "abort", updatedAt: ctx.now });
            await ctx.scheduler.runAfter(1000, internal.agent.streams.resetThreadStatusToActive, { threadId });
        }

        return streams.length > 0;
    });

/**
 * Deletes an empty pending row and moves the thread's leaf off it onto the row before it, so no branch is left on a
 * deleted row. The parent is read first: an implicit parent cannot be found once its child is gone.
 */
const removeEmptyPending = async (ctx: MutationCtx, threadId: Id<"threads">, pending: Doc<"messages">) => {
    const parent = await parentOf(ctx, threadId, pending);
    const thread = await ctx.db.get(threadId);

    await deleteMessage(ctx, pending);

    if (thread?.activeLeafMessageId === pending._id) {
        await patchRow(ctx.db, thread, { activeLeafMessageId: parent?._id });

        if (parent) {
            await syncActiveAgent(ctx, threadId, parent._id);
        }
    }
};

/**
 * The run a sidebar stop refused saves the text it still owes its reply: what it wrote since its last
 * finished step (`text`, `reasoning`). Each finished step is already a saved message, so no chunk is read here.
 *
 * The reply's row is the pending one for `order` (the step in flight). A continuation has none until a step
 * saves (start.ts: `forceNewOrder` skips the pending row), so then the text becomes a new row at `order`, after
 * `promptMessageId`, the way the agent saves a continuation's rows. No text, no row.
 *
 * Only a stream a stop ended counts: a timeout or a failure is left to the run's own error path. The thread
 * leaves `running` in every case it returns true. Returns whether the stream was stopped, and the id of the row it saved.
 * Called once per run: a redelivery never gets here (`claimStreamRun`), and a second Stop finds no live stream.
 */
export const finishStoppedReply = internalMutation
    .input({
        agentName: v.optional(v.string().max(MAX_LENGTH.short)),
        /** A continuation's rows take their own order and branch from the tool result (`promptMessageId`). */
        continuation: v.boolean(),
        order: v.number(),
        pendingReasoning: v.string().max(MAX_LENGTH.document),
        pendingText: v.string().max(MAX_LENGTH.document),
        promptMessageId: v.string().max(MAX_LENGTH.id),
        streamId: v.id("persistentStreams"),
    })
    .output(v.object({ messageId: v.optional(v.id("messages")), stopped: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: args.streamId } });

        if (!stream || stream.status !== "done") {
            return { stopped: false };
        }

        const threadId = stream.threadId as Id<"threads">;
        let messageId: Id<"messages"> | undefined;

        // A steered run carries on below its latest steered message (`chat/steering.ts`): its pending
        // row and the text it owes belong in that message's order, with that message as their prompt.
        const steeredId = latestSteerMessageId(stream.steers as SteerEntry[] | undefined);
        const steerRow = steeredId ? await ctx.db.messages.findFirst({ where: { _id: steeredId as Id<"messages">, threadId } }) : null;
        const order = steerRow?.order ?? args.order;

        let pending = await ctx.db.messages.findFirst({
            orderBy: [{ stepOrder: "desc" }],
            where: { order, status: "pending", threadId, tool: false },
        });

        // The delivered steer's row is gone (deleted since), but `insertSteerRow` already moved the run's pending row
        // into that row's order, so the run's own order finds nothing. The delivery recorded that row's id: saving into
        // it keeps the owed text, and an empty one is removed instead of left pending.
        const movedId = steeredId && !steerRow ? latestSteerPendingId(stream.steers as SteerEntry[] | undefined) : undefined;

        if (!pending && movedId) {
            const moved = await ctx.db.messages.findFirst({ where: { _id: movedId as Id<"messages">, threadId } });

            pending = moved?.status === "pending" && !moved.tool ? moved : null;
        }

        if (args.pendingText.length === 0 && args.pendingReasoning.length === 0) {
            // Nothing owed: the step in flight wrote no text, so its empty placeholder goes. Left pending, the abort
            // that ends the run would mark it failed, and the reply would reload as an error.
            if (pending) {
                await removeEmptyPending(ctx, threadId, pending);
            }
        } else {
            const content = [
                ...(args.pendingReasoning ? [{ text: args.pendingReasoning, type: "reasoning" as const }] : []),
                ...(args.pendingText ? [{ text: args.pendingText, type: "text" as const }] : []),
            ];
            let placement = args.continuation
                ? { overrideOrder: args.order, parentMessageId: args.promptMessageId, promptMessageId: undefined }
                : { overrideOrder: undefined, parentMessageId: undefined, promptMessageId: args.promptMessageId as Id<"messages"> };

            if (steerRow) {
                placement = { overrideOrder: undefined, parentMessageId: undefined, promptMessageId: steerRow._id };
            }

            const saved = await addMessagesHandler(ctx, {
                agentName: args.agentName,
                failPendingSteps: false,
                messages: [{ message: { content, role: "assistant" }, status: "success" }],
                pendingMessageId: pending?._id,
                threadId,
                userId: stream.userId,
                ...placement,
            });

            messageId = saved.messages[0]?._id as Id<"messages"> | undefined;
        }

        await patchThread(ctx.db, threadId, { status: "active", updatedAt: ctx.now });

        return { stopped: true, ...(messageId !== undefined && { messageId }) };
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
            // Likewise the text before a steered message (`restart`).
            const lastMarker = allChunks.findLastIndex((chunk) => chunk.speaker || chunk.restart);
            const chunks = lastMarker === -1 ? allChunks : allChunks.slice(lastMarker);

            speaker = lastMarker === -1 ? undefined : (allChunks[lastMarker]?.speaker ?? undefined);

            // A steer delivered whose marker is not written yet (the next step never started: a stop or a failure came
            // first): everything written so far is above the steered message, so nothing is the current reply's.
            const deliveries = new Set((stream.steers ?? []).flatMap((entry) => (entry.status === "delivered" && entry.messageId ? [entry.messageId] : [])));

            if (deliveries.size <= allChunks.filter((chunk) => chunk.restart).length) {
                text = chunks.map((chunk) => chunk.text).join("");
                reasoning = chunks.map((chunk) => chunk.reasoning || "").join("");
            }
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

/** Statuses after which a stream writes no more chunks (`http-api.ts` stops polling on them too). */
const SETTLED_STREAM_STATUSES: ReadonlySet<string> = new Set(["done", "error", "timeout"]);

export const getChunksAfter = internalQuery
    .input({
        afterIndex: v.number(),
        /**
         * Check the thread's lock before answering. Default true: a caller that does
         * not pass it is always checked. The chunk poll passes false on its later
         * reads, which are checked anyway whenever they return chunks or a settled status.
         */
        checkLock: v.optional(v.boolean()),
        streamId: v.id("persistentStreams"),
    })
    .output(
        v.object({
            chunks: v.array(
                v.object({
                    reasoning: v.optional(v.string()),
                    restart: v.optional(v.boolean()),
                    speaker: v.optional(v.object({ name: v.string(), skillId: v.string() })),
                    text: v.string(),
                }),
            ),
            /**
             * The stream's thread was locked after the stream started. Answered in
             * this query so the poll needs no second round trip. A locked stream
             * returns no chunks, and `locked` is false whenever the lock was not checked.
             */
            locked: v.boolean(),
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
    .query(async ({ args: { afterIndex, checkLock = true, streamId }, ctx }) => {
        // One indexed row, not an un-hinted `db.get` (which probes every table).
        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: streamId } });

        // A missing stream is an error, not a lock: an expired one must not read as "This chat is locked."
        if (!stream) {
            return { chunks: [], locked: false, status: "error", totalChunks: afterIndex };
        }

        const status = stream.status as StreamStatus;
        const mustCheck = checkLock || SETTLED_STREAM_STATUSES.has(status);
        const lockedAnswer = { chunks: [], locked: true, status, totalChunks: afterIndex };

        // Before any content leaves: at once when asked, and always when the stream has settled.
        if (mustCheck && (await streamLockedAfterStart(ctx, stream))) {
            return lockedAnswer;
        }

        const toChunk = (c: { reasoning?: string | null; restart?: boolean | null; speaker?: { name: string; skillId: string } | null; text: string }) => {
            return { reasoning: c.reasoning ?? undefined, ...(c.restart && { restart: true }), ...(c.speaker && { speaker: c.speaker }), text: c.text };
        };

        // Only the chunks past the cursor, in order. With nothing new this is
        // an empty index range: the poll reads the stream row and no chunk.
        const { page } = await ctx.db.persistentChunks.findMany({
            orderBy: [{ seq: "asc" }],
            where: { seq: { gte: afterIndex }, streamId },
        });
        const lastChunk = page.at(-1);

        // A later read of a long-poll skipped the check above; check before these chunks leave.
        if (!mustCheck && page.length > 0 && (await streamLockedAfterStart(ctx, stream))) {
            return lockedAnswer;
        }

        return { chunks: page.map((chunk) => toChunk(chunk)), locked: false, status, totalChunks: lastChunk ? lastChunk.seq + 1 : afterIndex };
    });
