import type { ModelMessage } from "ai";
import type { PaginationOptions, PaginationResult } from "lunorash/server";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import { parse } from "../../lib/validators";
import { serializeMessage } from "../mapping";
import { toUIMessages, type UIMessage } from "../ui-messages";
import type { MessageDoc } from "../validators";
import {
    type Message,
    type MessageEmbeddings,
    type MessageEmbeddingsWithDimension,
    type MessageStatus,
    type MessageWithMetadata,
    vMessageWithMetadata,
} from "../validators";
import { validateVectorDimension } from "../vector/tables";
import type { ActionCtx as ActionContext, AgentComponent, MutationCtx as MutationContext, QueryCtx as QueryContext, RunnerCtx as RunnerContext } from "./types";

/**
 * List messages from a thread.
 * @param ctx A ctx object from a query, mutation, or action.
 * @param _component The agent component, usually `components.agent` (unused; reads go through `internal`).
 * @param args.threadId The thread to list messages from.
 * @param args.paginationOpts Pagination options (e.g. via usePaginatedQuery).
 * @param args.excludeToolMessages Whether to exclude tool messages.
 * False by default.
 * @param args.statuses What statuses to include. All by default.
 * @returns The MessageDoc's in a format compatible with usePaginatedQuery.
 */
export const listMessages = async (
    ctx: QueryContext | MutationContext | ActionContext,
    // Kept for the call signature; the read goes through `internal` now.
    _component: AgentComponent,
    {
        excludeToolMessages,
        paginationOpts,
        statuses,
        threadId,
    }: {
        excludeToolMessages?: boolean;
        paginationOpts: PaginationOptions;
        statuses?: MessageStatus[];
        threadId: string;
    },
): Promise<PaginationResult<MessageDoc>> => {
    if (paginationOpts.numItems === 0) {
        return {
            continueCursor: paginationOpts.cursor ?? "",
            isDone: true,
            page: [],
        };
    }

    // Internal: every caller has authorized the thread already, and the agent
    // loop often runs with no user identity, where the public query answers an
    // empty page.
    return ctx.runQuery(internal.agent.messages.listMessagesByThreadIdInternal, {
        excludeToolMessages,
        order: "desc",
        // `PaginationOptions.cursor` is optional, but the wire validator declares
        // it `nullable(string)` — present, possibly null. Absent and null both mean
        // "start at the beginning", which is how the early return above already
        // reads it, so normalise rather than widen the shared validator.
        paginationOpts: { ...paginationOpts, cursor: paginationOpts.cursor ?? null },
        statuses,
        threadId: threadId as Id<"threads">,
    });
};

export const listUIMessages = async (
    context: QueryContext | MutationContext | ActionContext,
    component: AgentComponent,
    args: {
        paginationOpts: PaginationOptions;
        threadId: string;
    },
): Promise<PaginationResult<UIMessage>> => {
    const result = await listMessages(context, component, {
        ...args,
        statuses: ["success", "pending", "failed"],
    });

    return { ...result, page: toUIMessages(result.page) };
};

export type SaveMessagesArgs = {
    /**
     * The embeddings to save with the messages.
     */
    embeddings?: MessageEmbeddings;

    /**
     * If true, it will fail any pending steps.
     * Defaults to false.
     */
    failPendingSteps?: boolean;

    /**
     * The messages to save.
     */
    messages: (ModelMessage | Message)[];

    /**
     * Metadata to save with the messages. Each element corresponds to the
     * message at the same index.
     */
    metadata?: Omit<MessageWithMetadata, "message">[];

    /**
     * A pending message ID to replace when adding messages.
     */
    pendingMessageId?: string;

    /**
     * The message that these messages are in response to. They will be
     * the same "order" as this message, at increasing stepOrder(s).
     */
    promptMessageId?: string;
    threadId: string;
    userId?: string | null;
};

/**
 * Explicitly save messages associated with the thread (& user if provided).
 */
export const saveMessages = async (
    context: MutationContext | ActionContext | RunnerContext,
    // `component: AgentComponent` used to sit here. The previous runtime addressed the agent's
    // functions through the component handle; Lunora addresses the generated api
    // directly, so the parameter had no reader left — it was threaded through
    // three call sites purely to be discarded.
    args: SaveMessagesArgs & {
        /**
         * The agent name to associate with the messages.
         */
        agentName?: string;
    },
): Promise<{ messages: MessageDoc[] }> => {
    let embeddings: MessageEmbeddingsWithDimension | undefined;

    if (args.embeddings) {
        const dimension = args.embeddings.vectors.find((v) => v !== null)?.length;

        if (dimension) {
            validateVectorDimension(dimension);
            embeddings = {
                dimension,
                model: args.embeddings.model,
                vectors: args.embeddings.vectors,
            };
        }
    }

    const result = await context.runMutation(internal.agent.messages.addMessages, {
        agentName: args.agentName,
        embeddings,
        failPendingSteps: args.failPendingSteps ?? false,
        messages: (await Promise.all(
            args.messages.map(async (m, i) => {
                const { fileIds, message } = await serializeMessage(context, m);
                const base = args.metadata?.[i];
                const allFileIds = [...(base?.fileIds ?? [])];

                if (fileIds) {
                    allFileIds.push(...fileIds);
                }

                return parse(vMessageWithMetadata, {
                    ...base,
                    message,
                    ...(allFileIds.length > 0 && { fileIds: allFileIds }),
                });
            }),
        )) as any, // Messages with string IDs cast to proper schema
        pendingMessageId: args.pendingMessageId as Id<"messages"> | undefined,
        promptMessageId: args.promptMessageId as Id<"messages"> | undefined,
        threadId: args.threadId as Id<"threads">,
        userId: args.userId ?? undefined,
    });

    return { messages: result.messages };
};

export type SaveMessageArgs = {
    /**
     * The embedding to save with the message.
     */
    embedding?: { model: string; vector: number[] };

    /**
     * Metadata to save with the messages. Each element corresponds to the
     * message at the same index.
     */
    metadata?: Omit<MessageWithMetadata, "message">;

    /**
     * A pending message ID to replace with this message.
     */
    pendingMessageId?: string;

    /**
     * The message that these messages are in response to. They will be
     * the same "order" as this message, at increasing stepOrder(s).
     */
    promptMessageId?: string;
    threadId: string;
    userId?: string | null;
} & (
    | {
          /**
           * The message to save.
           */
          message: ModelMessage | Message;
          prompt?: undefined;
      }
    | {
          message?: undefined;
          /*
           * The prompt to save with the message.
           */
          prompt: string;
      }
);

/**
 * Save a message to the thread.
 * @param ctx A ctx object from a mutation or action.
 * @param args The message and what to associate it with (user / thread)
 * You can pass extra metadata alongside the message, e.g. associated fileIds.
 * @returns The messageId of the saved message.
 */
export const saveMessage = async (
    ctx: MutationContext | ActionContext | RunnerContext,
    // `component: AgentComponent` removed — see the note on `saveMessages`.
    args: SaveMessageArgs & {
        /**
         * The agent name to associate with the message.
         */
        agentName?: string;
    },
) => {
    let embeddings: { model: string; vectors: number[][] } | undefined;

    if (args.embedding && args.embedding.vector) {
        embeddings = {
            model: args.embedding.model,
            vectors: [args.embedding.vector],
        };
    }

    const { messages } = await saveMessages(ctx, {
        agentName: args.agentName,
        embeddings,
        messages: args.prompt === undefined ? [args.message] : [{ content: args.prompt, role: "user" }],
        metadata: args.metadata ? [args.metadata] : undefined,
        pendingMessageId: args.pendingMessageId,
        promptMessageId: args.promptMessageId,
        threadId: args.threadId,
        userId: args.userId ?? undefined,
    });
    const message = messages.at(-1)!;

    return { message, messageId: message._id };
};
