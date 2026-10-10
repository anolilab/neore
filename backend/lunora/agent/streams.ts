import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx as MutationContext, type QueryCtx as QueryContext } from "../_generated/server";
import { query } from "../lib/crpc";
import { getAuthUserIdentity } from "../auth";

/**
 * Streaming message operations.
 * Migrated from `@neore/backend-agent` component.
 */
import { pick } from "../lib/collections";
import { admittedThreadDb } from "./admitted-thread-db";
import { resolveThreadReadAccess } from "./thread-read-access";
import { mergedStream, stream } from "../lib/streams";
import { streamDeltasFields, streamingMessagesFieldsWithoutState } from "../schema";
import {
    deriveUIMessagesFromDeltas,
    fromUIMessages,
    type MessageWithMetadataInternal,
    type StreamDelta,
    type StreamMessage,
    vStreamDelta,
    vStreamMessage,
} from "./client";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const MAX_DELTAS_PER_REQUEST = 2000;
const MAX_DELTAS_PER_STREAM = 500;
const TIMEOUT_INTERVAL = 10 * MINUTE;
const DELETE_STREAM_DELAY = MINUTE * 5;

export const addDelta = internalMutation
    .input(streamDeltasFields)
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const innerStream = (await ctx.db.get(args.streamId)) as { state: { kind: string } } | null;

        if (!innerStream) {
            console.warn("Stream not found", args.streamId);

            return false;
        }

        if (innerStream.state.kind !== "streaming") {
            return false;
        }

        await ctx.db.insert("streamDeltas", args);
        await heartbeatStream(ctx, { streamId: args.streamId });

        return true;
    });

export const listDeltas = query
    .input({
        cursors: v.array(v.object({ cursor: v.number(), streamId: v.id("streamingMessages") })),
        threadId: v.id("threads"),
    })
    .output(v.from(v.array(vStreamDelta)))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return [];
        }

        // Raw stream rows (user ids, provider options, tool payloads): owner or live
        // grantee only. `isPublic` grants nothing here — see `thread-read-access.ts`.
        const access = await resolveThreadReadAccess(ctx, args.threadId, identity.userId);

        if (access?.kind !== "full") {
            return [];
        }

        return listDeltasHandler(ctx, args);
    });

/**
 * Direct handler for listing stream deltas.
 * Exported for hot-path queries to bypass runQuery validator overhead.
 */
export const listDeltasHandler = async (
    context: QueryContext,
    args: { cursors: { cursor: number; streamId: Id<"streamingMessages"> }[]; threadId: Id<"threads"> },
): Promise<StreamDelta[]> => {
    let totalDeltas = 0;
    const deltas: StreamDelta[] = [];

    for (const cursor of args.cursors) {
        // Bind each streamId to args.threadId. Without this, an authenticated
        // caller with access to a public thread can pass cursors for streamIds
        // belonging to private threads and read the streaming output.
        const innerStream = await context.db.get(cursor.streamId);

        if (!innerStream || innerStream.threadId !== args.threadId) {
            continue;
        }

        const streamDeltas = await context.db
            .query("streamDeltas")
            .withIndex("streamId_start_end", (q) => q.eq("streamId", cursor.streamId).gte("start", cursor.cursor))
            .take(Math.min(MAX_DELTAS_PER_STREAM, MAX_DELTAS_PER_REQUEST - totalDeltas));

        totalDeltas += streamDeltas.length;
        deltas.push(...streamDeltas.map((d) => pick(d, ["streamId", "start", "end", "parts"])));

        if (totalDeltas >= MAX_DELTAS_PER_REQUEST) {
            break;
        }
    }

    return deltas;
};

export const create = internalMutation
    .input(streamingMessagesFieldsWithoutState)
    .output(v.id("streamingMessages"))
    .mutation(async ({ args, ctx }) => {
        const state = { kind: "streaming" as const, lastHeartbeat: ctx.now };
        // `stateKind` mirrors `state.kind` and is what the
        // `threadId_state_order_stepOrder` index actually reads — Lunora cannot
        // index a nested path. Every write of one must write the other.
        const streamId = await ctx.db.insert("streamingMessages", {
            ...args,
            state,
            stateKind: state.kind,
        });
        const timeoutFunctionId = await ctx.scheduler.runAfter(TIMEOUT_INTERVAL, internal.agent.streams.timeoutStream, { streamId });

        await ctx.db.patch(streamId, { state: { ...state, timeoutFnId: timeoutFunctionId }, stateKind: state.kind });

        // Update thread status to "running" when stream starts
        const thread = await ctx.db.get(args.threadId);

        if (thread && thread.status === "active") {
            await ctx.db.patch(args.threadId, { status: "running", updatedAt: ctx.now });
        }

        return streamId;
    });

export const list = query
    .input({
        startOrder: v.optional(v.number()),
        statuses: v.optional(v.array(v.union(v.literal("streaming"), v.literal("finished"), v.literal("aborted")))),
        threadId: v.id("threads"),
    })
    .output(v.from(v.array(vStreamMessage)))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return [];
        }

        // Raw stream rows (user ids, provider options, tool payloads): owner or live
        // grantee only. `isPublic` grants nothing here — see `thread-read-access.ts`.
        const access = await resolveThreadReadAccess(ctx, args.threadId, identity.userId);

        if (access?.kind !== "full") {
            return [];
        }

        return listHandler(ctx, args);
    });

/**
 * Direct handler for listing streaming messages.
 * Exported for hot-path queries to bypass runQuery validator overhead.
 */
export const listHandler = async (
    context: QueryContext,
    args: {
        startOrder?: number;
        statuses?: ("streaming" | "finished" | "aborted")[];
        threadId: Id<"threads">;
    },
): Promise<StreamMessage[]> => {
    const statuses = args.statuses ?? ["streaming"];
    const database = admittedThreadDb(context, args.threadId);
    const messages = await mergedStream<Doc<"streamingMessages">>(
        statuses.map((status) =>
            stream(database)
                .query<Doc<"streamingMessages">>("streamingMessages")
                .withIndex("threadId_state_order_stepOrder", (q) =>
                    q
                        .eq("threadId", args.threadId)
                        .eq("stateKind", status)
                        .gte("order", args.startOrder ?? 0),
                )
                .order("desc"),
        ),
        ["order", "stepOrder"],
    ).take(100);

    return messages.map((m) => publicStreamMessage(m as unknown as Doc<"streamingMessages">));
};

const publicStreamMessage = (m: Doc<"streamingMessages">): StreamMessage => {
    return {
        status: m.state.kind,
        streamId: m._id,
        ...pick(m, ["format", "order", "stepOrder", "userId", "agentName", "model", "provider", "providerOptions"]),
    };
};

export const abortByOrder = internalMutation
    .input({ order: v.number(), reason: v.string(), threadId: v.id("threads") })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const streams = await ctx.db
            .query("streamingMessages")
            .withIndex("threadId_state_order_stepOrder", (q) => q.eq("threadId", args.threadId).eq("stateKind", "streaming").eq("order", args.order))
            .take(100);

        for (const innerStream of streams) {
            await abortById(ctx, { reason: args.reason, streamId: innerStream._id });
        }

        return streams.length > 0;
    });

export const abort = internalMutation
    .input({
        finalDelta: v.optional(v.object(streamDeltasFields)),
        reason: v.string(),
        streamId: v.id("streamingMessages"),
    })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => await abortById(ctx, args));

async function abortById(
    context: MutationContext,
    args: {
        finalDelta?: Omit<Doc<"streamDeltas">, "_creationTime" | "_id">;
        reason: string;
        streamId: Id<"streamingMessages">;
    },
) {
    const innerStream = await context.db.get(args.streamId);

    if (!innerStream) {
        throw new Error(`Stream not found: ${args.streamId}`);
    }

    if (args.finalDelta) {
        await context.db.insert("streamDeltas", args.finalDelta);
    }

    if (innerStream.state.kind !== "streaming") {
        return false;
    }

    await cleanupTimeoutFunction(context, innerStream);
    await context.db.patch(args.streamId, {
        state: { kind: "aborted", reason: args.reason },
        stateKind: "aborted",
    });

    await updateThreadStatusAfterStreamEnd(context, innerStream.threadId, "abort");

    return true;
}

const cleanupTimeoutFunction = async (context: MutationContext, innerStream: Doc<"streamingMessages">) => {
    if (innerStream.state.kind === "streaming" && innerStream.state.timeoutFnId) {
        // The previous runtime exposed scheduled functions as a system table with a
        // `state.kind` of pending/inProgress/success. Lunora's scheduler owns
        // them: `get` returns the record while it is queued and null once it has
        // run or been cancelled, so "still pending" is "still there".
        await context.scheduler.cancel(innerStream.state.timeoutFnId);
    }
};

const updateThreadStatusAfterStreamEnd = async (context: MutationContext, threadId: Id<"threads">, endStatus: "finish" | "abort" | "error") => {
    const hasActiveStream = await context.db
        .query("streamingMessages")
        .withIndex("threadId_state_order_stepOrder", (q) => q.eq("threadId", threadId).eq("stateKind", "streaming"))
        .first();

    if (!hasActiveStream) {
        const thread = await context.db.get(threadId);

        if (thread) {
            await context.db.patch(threadId, { status: endStatus, updatedAt: Date.now() });
            await context.scheduler.runAfter(1000, internal.agent.streams.resetThreadStatusToActive, { threadId });
        }
    }
};

export const finish = internalMutation
    .input({
        finalDelta: v.optional(v.object(streamDeltasFields)),
        streamId: v.id("streamingMessages"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => await finishHandler(ctx, args));

export async function finishHandler(
    context: MutationContext,
    args: {
        finalDelta?: Omit<Doc<"streamDeltas">, "_creationTime" | "_id">;
        streamId: Id<"streamingMessages">;
    },
): Promise<null> {
    if (args.finalDelta) {
        await context.db.insert("streamDeltas", args.finalDelta);
    }

    const innerStream = await context.db.get(args.streamId);

    if (!innerStream) {
        throw new Error(`Stream not found: ${args.streamId}`);
    }

    if (innerStream.state.kind !== "streaming") {
        console.warn(`Stream trying to finish ${args.streamId} but is ${innerStream.state.kind}`);

        return null;
    }

    await cleanupTimeoutFunction(context, innerStream);
    const cleanupFunctionId = await context.scheduler.runAfter(DELETE_STREAM_DELAY, internal.agent.streams.deleteStreamAsync, { streamId: args.streamId });

    await context.db.patch(args.streamId, {
        state: { cleanupFnId: cleanupFunctionId, endedAt: Date.now(), kind: "finished" },
        stateKind: "finished",
    });

    await updateThreadStatusAfterStreamEnd(context, innerStream.threadId, "finish");

    return null;
}

export const heartbeat = internalMutation
    .input({ streamId: v.id("streamingMessages") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => await heartbeatStream(ctx, args));

async function heartbeatStream(context: MutationContext, args: { streamId: Id<"streamingMessages"> }): Promise<null> {
    const innerStream = await context.db.get(args.streamId);

    if (!innerStream) {
        console.warn("Stream not found", args.streamId);

        return null;
    }

    if (innerStream.state.kind !== "streaming") {
        return null;
    }

    if (Date.now() - innerStream.state.lastHeartbeat < TIMEOUT_INTERVAL / 4) {
        return null;
    }

    if (!innerStream.state.timeoutFnId) {
        throw new Error("Stream has no timeout function");
    }

    // See `cleanupTimeoutFn`: a null record means the timeout already fired, and
    // re-arming the heartbeat is exactly what should happen then. The previous runtime threw
    // here because its system table kept completed rows around and a non-pending
    // one meant something was wrong; Lunora's simply drops them.
    await context.scheduler.cancel(innerStream.state.timeoutFnId);
    const timeoutFunctionId = await context.scheduler.runAfter(TIMEOUT_INTERVAL, internal.agent.streams.timeoutStream, { streamId: args.streamId });

    await context.db.patch(args.streamId, {
        state: { kind: "streaming", lastHeartbeat: Date.now(), timeoutFnId: timeoutFunctionId },
        stateKind: "streaming",
    });

    return null;
}

export const timeoutStream = internalMutation
    .input({ streamId: v.id("streamingMessages") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const innerStream = await ctx.db.get(args.streamId);

        if (!innerStream || innerStream.state.kind !== "streaming") {
            console.warn("Stream not found", args.streamId);

            return null;
        }

        await ctx.db.patch(args.streamId, {
            state: { kind: "aborted", reason: "timeout" },
            stateKind: "aborted",
        });

        await updateThreadStatusAfterStreamEnd(ctx, innerStream.threadId, "error");

        return null;
    });

const deletePageForStreamId = async (context: MutationContext, args: { cursor?: string; streamId: Id<"streamingMessages"> }) => {
    const deltas = await context.db
        .query("streamDeltas")
        .withIndex("streamId_start_end", (q) => q.eq("streamId", args.streamId))
        .paginate({
            cursor: args.cursor ?? null,
            numItems: MAX_DELTAS_PER_REQUEST,
        });

    await Promise.all(deltas.page.map((d) => context.db.delete(d._id)));

    if (deltas.isDone) {
        const innerStream = await context.db.get(args.streamId);

        if (innerStream) {
            await cleanupTimeoutFunction(context, innerStream);

            if (innerStream.state.kind === "finished" && innerStream.state.cleanupFnId) {
                await context.scheduler.cancel(innerStream.state.cleanupFnId);
            }

            await context.db.delete(args.streamId);
        }
    }

    return deltas;
};

export const deleteStreamsPageForThreadId = async (context: MutationContext, args: { deltaCursor?: string; streamOrder?: number; threadId: Id<"threads"> }) => {
    // Was `streamingMessagesFields.state.members.flatMap(s => s.fields.kind.value)`
    // — the previous validators exposed their union members at runtime; Lunora's do not.
    // These are the values of the denormalised `stateKind` column, which is what
    // the index below is keyed on anyway.
    const allStreamMessages = (["streaming", "finished", "aborted"] as const).map((stateKind) =>
        stream(context.db)
            .query<Doc<"streamingMessages">>("streamingMessages")
            .withIndex("threadId_state_order_stepOrder", (q) =>
                q
                    .eq("threadId", args.threadId)
                    .eq("stateKind", stateKind)
                    .gte("order", args.streamOrder ?? 0),
            ),
    );
    let { deltaCursor } = args;
    const streamMessage = await mergedStream<Doc<"streamingMessages">>(allStreamMessages, ["threadId", "stateKind", "order", "stepOrder"]).first();

    if (!streamMessage) {
        return { deltaCursor: undefined, isDone: true, streamOrder: undefined };
    }

    const result = await deletePageForStreamId(context, {
        cursor: deltaCursor,
        streamId: streamMessage._id,
    });

    if (result.isDone) {
        deltaCursor = undefined;
    }

    return { deltaCursor, isDone: false, streamOrder: streamMessage.order };
};

export const deleteStreamsPageForThreadIdMutation = internalMutation
    .input({
        deltaCursor: v.optional(v.string()),
        streamOrder: v.optional(v.number()),
        threadId: v.id("threads"),
    })
    .output(
        v.object({
            deltaCursor: v.optional(v.string()),
            isDone: v.boolean(),
            streamOrder: v.optional(v.number()),
        }),
    )
    .mutation(async ({ args, ctx }) => await deleteStreamsPageForThreadId(ctx, args));

export const deleteAllStreamsForThreadIdAsync = internalMutation
    .input({
        deltaCursor: v.optional(v.string()),
        streamOrder: v.optional(v.number()),
        threadId: v.id("threads"),
    })
    .output(
        v.object({
            deltaCursor: v.optional(v.string()),
            isDone: v.boolean(),
            streamOrder: v.optional(v.number()),
        }),
    )
    .mutation(async ({ args, ctx }) => {
        const result = await deleteStreamsPageForThreadId(ctx, args);

        if (result.isDone) {
            await ctx.db.delete(args.threadId);
        } else {
            await ctx.scheduler.runAfter(0, internal.agent.streams.deleteAllStreamsForThreadIdAsync, {
                deltaCursor: result.deltaCursor,
                streamOrder: result.streamOrder,
                threadId: args.threadId,
            });
        }

        return result;
    });

export const deleteStreamSync = internalMutation
    .input({ streamId: v.id("streamingMessages") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        let deltas = await deletePageForStreamId(ctx, args);

        while (!deltas.isDone) {
            deltas = await deletePageForStreamId(ctx, {
                ...args,
                cursor: deltas.continueCursor ?? undefined,
            });
        }

        return null;
    });

export const resetThreadStatusToActive = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.threadId);

        if (thread && ["abort", "error", "finish"].includes(thread.status)) {
            await ctx.db.patch(args.threadId, { status: "active", updatedAt: ctx.now });
        }

        return null;
    });

export const deleteStreamAsync = internalMutation
    .input({ cursor: v.optional(v.string()), streamId: v.id("streamingMessages") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const result = await deletePageForStreamId(ctx, args);

        if (!result.isDone) {
            await ctx.scheduler.runAfter(0, internal.agent.streams.deleteStreamAsync, {
                // `?? undefined`: Lunora's paginate returns `null` once exhausted, and
                // the recursive arg is `v.optional(v.string())`.
                cursor: result.continueCursor ?? undefined,
                streamId: args.streamId,
            });
        }

        return null;
    });

export const deleteAllStreamsForThreadIdSync = internalAction
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        let result = await ctx.runMutation(internal.agent.streams.deleteStreamsPageForThreadIdMutation, args);

        while (!result.isDone) {
            result = await ctx.runMutation(internal.agent.streams.deleteStreamsPageForThreadIdMutation, {
                ...args,
                deltaCursor: result.deltaCursor,
                streamOrder: result.streamOrder,
            });
        }

        // Declared `.output(v.null())`; return it rather than falling off the
        // end, which yields `undefined` and does not match the contract.
        return null;
    });

export const getStreamingMessages = async (
    context: MutationContext,
    threadId: Id<"threads">,
    order: number,
    stepOrder: number,
): Promise<Doc<"streamingMessages">[]> =>
    mergedStream<Doc<"streamingMessages">>(
        (["aborted", "streaming", "finished"] as const).map((state) =>
            stream(context.db)
                .query<Doc<"streamingMessages">>("streamingMessages")
                .withIndex("threadId_state_order_stepOrder", (q) =>
                    q.eq("threadId", threadId).eq("stateKind", state).eq("order", order).lte("stepOrder", stepOrder),
                )
                .order("desc"),
        ),
        ["stepOrder"],
    ).take(10);

export const getStreamingMessagesWithMetadata = async (
    context: MutationContext,
    { order, stepOrder, threadId }: { order: number; stepOrder: number; threadId: Id<"threads"> },
    metadata: { error?: string; status: "success" | "failed" },
): Promise<MessageWithMetadataInternal[]> => {
    const streamingMessages = await getStreamingMessages(context, threadId, order, stepOrder);
    const perStreamMessages = await Promise.all(
        streamingMessages.map(async (streamingMessage) => {
            const deltas = await context.db
                .query("streamDeltas")
                .withIndex("streamId_start_end", (q) => q.eq("streamId", streamingMessage._id))
                .take(200);
            const uiMessages = await deriveUIMessagesFromDeltas(threadId, [publicStreamMessage(streamingMessage)], deltas);
            const numberToSkip = stepOrder - streamingMessage.stepOrder;
            const fromUi = await fromUIMessages(uiMessages, streamingMessage);
            const innerMessages = await Promise.all(
                fromUi
                    .slice(numberToSkip)
                    .filter((m) => m.message !== undefined)
                    .map(
                        async (message) =>
                            ({
                                ...pick(message, [
                                    "message",
                                    "fileIds",
                                    "status",
                                    "finishReason",
                                    "model",
                                    "provider",
                                    "providerMetadata",
                                    "sources",
                                    "reasoning",
                                    "reasoningDetails",
                                    "usage",
                                    "warnings",
                                    "error",
                                ]),
                                ...metadata,
                            }) as MessageWithMetadataInternal,
                    ),
            );

            return innerMessages;
        }),
    );
    const messages = perStreamMessages.flat();

    return messages;
};
