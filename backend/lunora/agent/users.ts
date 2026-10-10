import type { InferArgs } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx as MutationContext } from "../_generated/server";

/**
 * User-related operations for agent data.
 * Migrated from `@neore/backend-agent` component.
 */
import { nullable, paginationOptionsValidator } from "../lib/validators";
import { stream } from "../lib/streams";
import { deleteMessage } from "./messages";
import { deleteStreamsPageForThreadId } from "./streams";
import { vPaginationResult } from "./validators";
// Note: it only searches for users with threads
export const listUsersWithThreads = internalQuery
    .input({
        paginationOpts: paginationOptionsValidator,
    })
    .output(v.from(vPaginationResult(v.string())))
    .query(async ({ args, ctx }) => {
        const results = await stream(ctx.db)
            .query<Doc<"threads">>("threads")
            .withIndex("by_user_and_status", (q) => q.gt("userId", ""))
            .distinct<Doc<"threads">>(["userId"])
            .paginate(args.paginationOpts);

        return {
            ...results,
            page: results.page.map((t) => t.userId).filter((t): t is string => !!t),
        };
    });

export const deleteAllForUserId = internalAction
    .input({ userId: v.string() })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        let threadsCursor = null;
        let threadInProgress = null;
        let messagesCursor = null;
        let isStreamsInProgress = false;
        let streamOrder;
        let deltaCursor;
        let isDone = false;

        while (!isDone) {
            const result: DeleteAllReturns = await ctx.runMutation(internal.agent.users._deletePageForUserId, {
                deltaCursor,
                messagesCursor,
                streamOrder,
                streamsInProgress: isStreamsInProgress,
                threadInProgress,
                threadsCursor,
                userId: args.userId,
            });

            messagesCursor = result.messagesCursor;
            threadInProgress = result.threadInProgress;
            threadsCursor = result.threadsCursor;
            isStreamsInProgress = result.streamsInProgress ?? false;
            streamOrder = result.streamOrder;
            deltaCursor = result.deltaCursor;
            isDone = result.isDone;
        }

        // Declared `.output(v.null())`; return it rather than falling off the
        // end, which yields `undefined` and does not match the contract.
        return null;
    });

export const deleteAllForUserIdAsync = internalMutation
    .input({
        userId: v.string(),
    })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const isDone = await deleteAllForUserIdAsyncHandler(ctx, {
            deltaCursor: undefined,
            messagesCursor: null,
            streamOrder: undefined,
            streamsInProgress: false,
            threadInProgress: null,
            threadsCursor: null,
            userId: args.userId,
        });

        return isDone;
    });

const deleteAllArgs = {
    deltaCursor: v.optional(v.string()),
    messagesCursor: nullable(v.string()),
    streamOrder: v.optional(v.number()),
    streamsInProgress: v.optional(v.boolean()),
    threadInProgress: nullable(v.id("threads")),
    threadsCursor: nullable(v.string()),
    userId: v.string(),
};

type DeleteAllArgs = InferArgs<typeof deleteAllArgs>;
const deleteAllReturns = {
    deltaCursor: v.optional(v.string()),
    isDone: v.boolean(),
    messagesCursor: nullable(v.string()),
    streamOrder: v.optional(v.number()),
    streamsInProgress: v.optional(v.boolean()),
    threadInProgress: nullable(v.id("threads")),
    threadsCursor: nullable(v.string()),
};

type DeleteAllReturns = InferArgs<typeof deleteAllReturns>;

export const _deleteAllForUserIdAsync = internalMutation
    .input(deleteAllArgs)
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => await deleteAllForUserIdAsyncHandler(ctx, args));

async function deleteAllForUserIdAsyncHandler(context: MutationContext, args: DeleteAllArgs): Promise<boolean> {
    const result = await deletePageForUserId(context, args);

    if (!result.isDone) {
        await context.scheduler.runAfter(0, internal.agent.users._deleteAllForUserIdAsync, {
            deltaCursor: result.deltaCursor,
            messagesCursor: result.messagesCursor,
            streamOrder: result.streamOrder,
            streamsInProgress: result.streamsInProgress ?? false,
            threadInProgress: result.threadInProgress,
            threadsCursor: result.threadsCursor,
            userId: args.userId,
        });
    }

    return result.isDone;
}

export const _deletePageForUserId = internalMutation
    .input(deleteAllArgs)
    .output(v.from(v.object(deleteAllReturns)))
    .mutation(async ({ args, ctx }) => await deletePageForUserId(ctx, args));

async function deletePageForUserId(context: MutationContext, args: DeleteAllArgs): Promise<DeleteAllReturns> {
    let { threadInProgress } = args;
    let { threadsCursor } = args;
    let { messagesCursor } = args;
    let isStreamsInProgress: boolean = args.streamsInProgress ?? false;
    let { streamOrder } = args;
    let { deltaCursor } = args;

    // Phase 1: Get a thread to work on if we don't have one
    if (!threadsCursor || !threadInProgress) {
        const threads = await context.db
            .query("threads")
            .withIndex("by_user_and_status", (q) => q.eq("userId", args.userId))
            .order("desc")
            .paginate({
                cursor: args.threadsCursor ?? null,
                numItems: 1,
            });

        threadsCursor = threads.continueCursor;
        const firstThread = threads.page[0];

        if (firstThread) {
            threadInProgress = firstThread._id;
            messagesCursor = null;
            isStreamsInProgress = false;
            streamOrder = undefined;
            deltaCursor = undefined;
        } else {
            return {
                deltaCursor,
                isDone: true,
                messagesCursor,
                streamOrder,
                streamsInProgress: isStreamsInProgress,
                threadInProgress,
                threadsCursor,
            };
        }
    }

    // Phase 2: Delete messages for the current thread
    if (!isStreamsInProgress) {
        const messages = await context.db
            .query("messages")
            .withIndex("threadId_status_tool_order_stepOrder", (q) => q.eq("threadId", threadInProgress!))
            .order("desc")
            .paginate({
                cursor: args.messagesCursor,
                numItems: 100,
            });

        await Promise.all(messages.page.map((m) => deleteMessage(context, m as unknown as Doc<"messages">)));

        if (messages.isDone) {
            isStreamsInProgress = true;
            messagesCursor = null;
            streamOrder = undefined;
            deltaCursor = undefined;
        } else {
            messagesCursor = messages.continueCursor;
        }

        return {
            deltaCursor,
            isDone: false,
            messagesCursor,
            streamOrder,
            streamsInProgress: isStreamsInProgress,
            threadInProgress,
            threadsCursor,
        };
    }

    // Phase 3: Delete streams for the current thread
    const streamResult = await deleteStreamsPageForThreadId(context, {
        deltaCursor,
        streamOrder,
        threadId: threadInProgress!,
    });

    if (streamResult.isDone) {
        await context.db.delete(threadInProgress);
        threadInProgress = null;
        messagesCursor = null;
        isStreamsInProgress = false;
        streamOrder = undefined;
        deltaCursor = undefined;
    } else {
        streamOrder = streamResult.streamOrder;
        deltaCursor = streamResult.deltaCursor;
    }

    return {
        deltaCursor,
        isDone: false,
        messagesCursor,
        streamOrder,
        streamsInProgress: isStreamsInProgress,
        threadInProgress,
        threadsCursor,
    };
}

export const getThreadUserId = internalQuery
    .input({
        threadId: v.id("threads"),
    })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.threadId);

        return thread?.userId ?? null;
    });
