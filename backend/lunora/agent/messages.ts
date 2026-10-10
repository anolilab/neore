import type { InferArgs, PaginationResult } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx as MutationContext, type QueryCtx as QueryContext } from "../_generated/server";
import { query } from "../lib/crpc";
import { getAuthUserIdentity } from "../auth";
import { omit } from "../lib/collections";

/**
 * Message operations.
 * Migrated from `@neore/backend-agent` component.
 *
 * NOTE: fileIds reference 'chatFiles' table (renamed from 'files')
 */
import { pick } from "../lib/collections";
import { assert } from "../lib/error-helpers";
import { paginationOptionsValidator, partial } from "../lib/validators";
import { mergedStream, stream } from "../lib/streams";
// Not through the `./client` barrel: it re-exports this module, so importing
// it here is a cycle, and whichever side loads first sees the other's
// validators as `undefined` at `.output(v.from(...))`.
import { DEFAULT_MESSAGE_RANGE, DEFAULT_RECENT_MESSAGES, extractText, isTool, sorted } from "./shared";
import {
    type Message,
    type MessageDoc,
    type MessageStatus,
    vMessageDoc as vMessageDocument,
    vMessageDocFields,
    vMessageEmbeddingsWithDimension,
    vMessageStatus,
    vMessageWithMetadataInternal,
    vPaginationResult,
} from "./validators";
import { loadBranchTree, parentOf, resolveLeafRow } from "./branch-rows";
import { BRANCH_ROOT, resolveActivePath, resolveBranchParent } from "./branch-tree";
import { changeRefcount } from "./files";
import { resolveThreadReadAccess } from "./thread-read-access";
import { getStreamingMessagesWithMetadata } from "./streams";
import { insertVector, searchVectors } from "./vector/index";
import { validateVectorDimension, type VectorTableId, vVectorId } from "./vector/tables";
import { patchRow, withoutUndefined } from "../lib/patch";
import { admittedThreadDb } from "./admitted-thread-db";
import { ownedChatFileIdsIn } from "../lib/storage-ownership";

const publicMessage = (message: Doc<"messages">): MessageDoc =>
    // Optional fields are never null at runtime (only undefined),
    // but the column builders generate null|T types in TypeScript.
    // Safe cast: runtime values are always T | undefined, never null.
    message as unknown as MessageDoc;

export const deleteMessage = async (context: MutationContext, messageDocument: Doc<"messages">) => {
    await context.db.delete(messageDocument._id);

    if (messageDocument.embeddingId) {
        await context.db.delete(messageDocument.embeddingId as Id<"embeddings_1536">);
    }

    if (messageDocument.fileIds) {
        await changeRefcount(context, messageDocument.fileIds, []);
    }
};

export const deleteByIds = internalMutation
    .input({ messageIds: v.array(v.id("messages")) })
    .output(v.array(v.id("messages")))
    .mutation(async ({ args, ctx }) => {
        const deletedMessageIds = await Promise.all(
            args.messageIds.map(async (id) => {
                const message = await ctx.db.get(id);

                if (message) {
                    await deleteMessage(ctx, message);

                    return id;
                }

                return null;
            }),
        );

        return deletedMessageIds.filter((id) => id !== null);
    });

/**
 * Was `vMessageDocFields.status.members.map((m) => m.value)` — the previous validators
 * carried their union members at runtime; Lunora's do not. Written out, and
 * `satisfies` keeps it honest against the validator's inferred type.
 */
export const messageStatuses = ["pending", "success", "failed"] as const satisfies ReadonlyArray<MessageStatus>;

export const deleteByOrder = internalMutation
    .input({
        endOrder: v.number(),
        endStepOrder: v.optional(v.number()),
        startOrder: v.number(),
        startStepOrder: v.optional(v.number()),
        threadId: v.id("threads"),
    })
    .output(
        v.object({
            isDone: v.boolean(),
            lastOrder: v.optional(v.number()),
            lastStepOrder: v.optional(v.number()),
        }),
    )
    .mutation(async ({ args, ctx }) => {
        const messages = await orderedMessagesStream(ctx, {
            sortOrder: "asc",
            startOrder: args.startOrder,
            startOrderBound: "gte",
            threadId: args.threadId,
        })
            .narrow<Doc<"messages">>({
                lowerBound: args.startStepOrder ? [args.startOrder, args.startStepOrder] : [args.startOrder],
                lowerBoundInclusive: true,
                upperBound: args.endStepOrder ? [args.endOrder, args.endStepOrder] : [args.endOrder],
                upperBoundInclusive: false,
            })
            .take(64);

        await Promise.all(messages.map((m) => deleteMessage(ctx, m as unknown as Doc<"messages">)));

        return {
            isDone: messages.length < 64,
            lastOrder: messages.at(-1)?.order,
            lastStepOrder: messages.at(-1)?.stepOrder,
        };
    });

const addMessagesArgs = {
    agentName: v.optional(v.string()),
    embeddings: v.optional(vMessageEmbeddingsWithDimension),
    failPendingSteps: v.optional(v.boolean()),
    hideFromUserIdSearch: v.optional(v.boolean()),
    messages: v.array(vMessageWithMetadataInternal),
    overrideOrder: v.optional(v.number()),
    /** Explicit branch parent for the first row inserted — see `branch-tree.ts`. */
    parentMessageId: v.optional(v.string()),
    pendingMessageId: v.optional(v.id("messages")),
    promptMessageId: v.optional(v.id("messages")),
    threadId: v.id("threads"),
    userId: v.optional(v.string()),
};

export const addMessages = internalMutation
    .input(addMessagesArgs)
    .output(v.from(v.object({ messages: v.array(vMessageDocument) })))
    .mutation(async ({ args, ctx }) => await addMessagesHandler(ctx, args));

export async function addMessagesHandler(context: MutationContext, args: InferArgs<typeof addMessagesArgs>) {
    let { userId } = args;
    const { threadId } = args;

    if (!userId && args.threadId) {
        const thread = await context.db.get(args.threadId);

        assert(thread, `Thread ${args.threadId} not found`);
        userId = thread.userId ?? undefined;
    }

    const { embeddings, failPendingSteps, hideFromUserIdSearch, messages, overrideOrder, parentMessageId, pendingMessageId, promptMessageId, ...rest } = args;

    const promptMessage = promptMessageId && (await context.db.get(promptMessageId));

    // Unset for a thread that never branched. Otherwise a row inserted right
    // under the stored leaf becomes the leaf, which keeps `resolveLeafRow`'s
    // descent at zero steps.
    const threadDocument = await context.db.get(threadId);
    let activeLeafId = threadDocument?.activeLeafMessageId ?? undefined;
    // A continuation (tool approval) owns a fresh `order` and saves into it
    // once per step; later saves resume after the rows earlier ones put there.
    const lastInOverrideOrder = overrideOrder === undefined ? null : await getMaxMessage(context, threadId, overrideOrder);
    // In-thread branching (`branch-tree.ts`): the first row this call inserts
    // may start a branch, and then it has to name its parent explicitly.
    const branchParentId = await resolveBranchParent(
        {
            activeLeafId,
            continuationHasRows: lastInOverrideOrder !== null,
            explicitParentId: parentMessageId,
            failPendingSteps,
            firstRole: messages[0]?.message.role,
            overrideOrder,
            patchesPending: pendingMessageId !== undefined,
            prompt: promptMessage ? { _id: promptMessage._id, role: (promptMessage.message as { role?: string } | undefined)?.role } : undefined,
            promptMessageId,
        },
        async () => {
            if (!activeLeafId) {
                return undefined;
            }

            const leafRow = await resolveLeafRow(context, threadId, activeLeafId);

            return leafRow?._id;
        },
    );

    if (failPendingSteps) {
        assert(args.threadId, "threadId is required to fail pending steps");
        const pendingMessages = await context.db
            .query("messages")
            .withIndex("threadId_status_tool_order_stepOrder", (q) => q.eq("threadId", threadId).eq("status", "pending"))
            .order("desc")
            .take(100);

        await Promise.all(
            pendingMessages
                .filter((m) => !promptMessage || m.order === promptMessage.order)
                .filter((m) => !pendingMessageId || m._id !== pendingMessageId)
                .map(async (m) => {
                    if (m.embeddingId) {
                        await context.db.delete(m.embeddingId as Id<"embeddings_1536">);
                    }

                    // The vector was just deleted, so the field is REMOVED
                    // (`patchRow`): a dangling id would point search at nothing.
                    await patchRow(context.db, m, { embeddingId: undefined, error: "Restarting", status: "failed" });
                }),
        );
    }

    let order;
    let stepOrder;
    let isFail = false;
    let error: string | undefined;

    if (overrideOrder !== undefined) {
        // Resume after earlier saves rather than restarting at 0 and colliding.
        order = overrideOrder;
        stepOrder = lastInOverrideOrder?.stepOrder ?? -1;
    } else if (promptMessageId) {
        assert(promptMessage, `Parent message ${promptMessageId} not found`);
        // Cross-thread guard: a caller could otherwise pass a promptMessageId
        // from another thread and corrupt ordering in args.threadId.
        assert(promptMessage.threadId === threadId, `Parent message ${promptMessageId} does not belong to thread ${threadId}`);

        if (promptMessage.status === "failed") {
            isFail = true;
            error = promptMessage.error ?? error ?? "The prompt message failed";
        }

        order = promptMessage.order;
        const maxMessage = await getMaxMessage(context, threadId, order);

        stepOrder = maxMessage?.stepOrder ?? promptMessage.stepOrder;
    } else {
        const maxMessage = await getMaxMessage(context, threadId);

        order = maxMessage?.order ?? -1;
        stepOrder = maxMessage?.stepOrder ?? -1;
    }

    const toReturn: Doc<"messages">[] = [];
    let insertedAny = false;

    if (embeddings) {
        assert(embeddings.vectors.length === messages.length, "embeddings.vectors.length must match messages.length");
    }

    for (const [i, entry] of messages.entries()) {
        if (!entry) {
            continue;
        }

        const message = await withToolResultFiles(context, userId, entry);
        let embeddingId: VectorTableId | undefined;
        const vector = embeddings?.vectors[i];

        if (vector && !isFail && message.status !== "failed") {
            embeddingId = await insertVector(context, embeddings.dimension, {
                model: embeddings.model,
                table: "messages",
                threadId,
                userId: hideFromUserIdSearch ? undefined : userId,
                vector,
            });
        }

        const messageDocument = {
            ...rest,
            ...message,
            embeddingId,
            error: isFail ? error : message.error,
            status: isFail ? "failed" : (message.status ?? "success"),
            text: hideFromUserIdSearch ? undefined : extractText(message.message),
            tool: isTool(message.message),
            userId,
            // Not `satisfies Omit<WithoutSystemFields<Doc<"messages">>, …>`.
            //
            // `message.usage` comes from a VALIDATED INPUT, so its optional fields
            // render as `key: T | undefined`; the same fields on the Doc render as
            // `key?: T`. Identical data, two spellings, and
            // `satisfies` compares them structurally. The insert below is the real
            // check — it takes the Doc shape and will reject a genuinely wrong
            // field.
        };

        if (i === 0 && pendingMessageId) {
            const pendingMessage = await context.db.get(pendingMessageId);

            assert(pendingMessage, `Pending msg ${pendingMessageId} not found`);

            if (pendingMessage.status === "failed") {
                isFail = true;
                error = `Trying to update a message that failed: ${pendingMessageId}, error: ${pendingMessage.error ?? error}`;
                messageDocument.status = "failed";
                messageDocument.error = error;
            }

            if (message.fileIds) {
                await changeRefcount(context, pendingMessage.fileIds ?? [], message.fileIds);
            }

            // Other undefined fields mean "unchanged" — the shard engine rejects
            // a patch that sets one to undefined, and the throw would be
            // swallowed by the agent's `onStepFinish`, leaving the row pending
            // forever. `embeddingId` is the exception: it describes the NEW
            // content, so an old vector must not survive it (`patchRow` removes
            // the field when there is no new one).
            await patchRow(context.db, pendingMessage, {
                ...withoutUndefined({ ...messageDocument, order: pendingMessage.order, stepOrder: pendingMessage.stepOrder }),
                ...(pendingMessage.embeddingId !== undefined && { embeddingId: messageDocument.embeddingId }),
            });
            // The row AS PATCHED: callers read the saved content back (the
            // approval requests a paused run records, the text memory
            // extraction reads), and the pre-patch row has an empty body.
            toReturn.push((await context.db.get(pendingMessage._id)) ?? pendingMessage);
            continue;
        }

        if (message.message.role === "user") {
            if (promptMessage && promptMessage.order === order) {
                const maxMessage = await getMaxMessage(context, threadId);

                order = (maxMessage?.order ?? order) + 1;
            } else {
                order += 1;
            }

            stepOrder = 0;
        } else {
            if (order < 0) {
                order = 0;
            }

            stepOrder += 1;
        }

        await pinFollowingRowParent(context, threadId, order);

        const insertedId = await context.db.insert("messages", {
            ...messageDocument,
            // Only the first row inserted; the rest follow it implicitly.
            ...(!insertedAny && branchParentId !== undefined && { parentMessageId: branchParentId }),
            order,
            stepOrder,
        });

        insertedAny = true;
        const messageId = insertedId as Id<"messages">;

        if (activeLeafId) {
            const inserted = await context.db.get(messageId);
            const parent = inserted && (await parentOf(context, threadId, inserted));

            if (parent?._id === activeLeafId) {
                await context.db.patch(threadId, { activeLeafMessageId: messageId });
                activeLeafId = messageId;
            }
        }

        if (message.fileIds) {
            await changeRefcount(context, [], message.fileIds);
        }

        toReturn.push((await context.db.get(messageId))!);
    }

    return { messages: toReturn.map((item) => publicMessage(item)) };
}

/**
 * A tool result's stored media — sandbox outputs, image edits, upscales — is
 * referenced only INSIDE its output, never in the message's `fileIds`, and
 * the unused-file sweep deletes every refcount-0 file after a day: the chart a
 * user downloaded yesterday was gone today. So the chat files a tool message
 * references, and its author holds a grant for, join its `fileIds`: counted
 * while the message exists, released by `deleteMessage` when the message, its
 * thread or the account is deleted.
 */
const withToolResultFiles = async <M extends { fileIds?: Id<"chatFiles">[]; message: { content?: unknown; role?: string } }>(
    context: MutationContext,
    userId: string | undefined,
    message: M,
): Promise<M> => {
    if (message.message.role !== "tool" || !userId) {
        return message;
    }

    const referenced = await ownedChatFileIdsIn(context.db, userId, message.message.content);

    if (referenced.length === 0) {
        return message;
    }

    return { ...message, fileIds: [...new Set([...(message.fileIds ?? []), ...referenced])] };
};

/**
 * A row with no `parentMessageId` follows the row before it (`branch-tree.ts`).
 * Inserting at the end of an `order` that is NOT the thread's last — a
 * regenerated reply or a tool result in an earlier turn — would silently make
 * the new row the parent of the first row of the next order. Pin that row to
 * its current parent first, so the insert changes nothing that was there.
 * One indexed read, and nothing more, for an ordinary append at the end.
 */
const pinFollowingRowParent = async (context: MutationContext, threadId: Id<"threads">, order: number): Promise<void> => {
    const nextRow = await context.db
        .query("messages")
        .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId).gt("order", order))
        .order("asc")
        .first();

    if (!nextRow || nextRow.parentMessageId) {
        return;
    }

    const previousRow = await context.db
        .query("messages")
        .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId).lte("order", order))
        .order("desc")
        .first();

    await context.db.patch(nextRow._id, { parentMessageId: previousRow?._id ?? BRANCH_ROOT });
};

export const getMaxMessage = async (context: QueryContext, threadId: Id<"threads">, order?: number): Promise<Doc<"messages"> | null> =>
    (await orderedMessagesStream(context, {
        sortOrder: "desc",
        startOrder: order,
        startOrderBound: "eq",
        threadId,
    }).first()) as Doc<"messages"> | null;

const orderedMessagesStream = (
    context: QueryContext,
    args: {
        sortOrder: "asc" | "desc";
        startOrder?: number;
        startOrderBound?: "gte" | "eq";
        threadId: Id<"threads">;
    },
) =>
    stream(context.db)
        .query<Doc<"messages">>("messages")
        .withIndex("by_threadId_order_stepOrder", (q) => {
            const qq = q.eq("threadId", args.threadId);

            if (args.startOrder !== undefined) {
                if (args.startOrderBound === "gte") {
                    return qq.gte("order", args.startOrder);
                }

                return qq.eq("order", args.startOrder);
            }

            return qq;
        })
        .order(args.sortOrder);

export const finalizeMessage = internalMutation
    .input({
        messageId: v.id("messages"),
        result: v.union(v.object({ status: v.literal("success") }), v.object({ error: v.string(), status: v.literal("failed") })),
    })
    .output(v.null())
    .mutation(async ({ args: { messageId, result }, ctx }) => {
        const message = await ctx.db.get(messageId);

        assert(message, `Message ${messageId} not found`);

        if (message.status !== "pending") {
            console.debug("Trying to finalize a message that's already", message.status);

            return null;
        }

        // `messages.message` is `v.optional(v.any())` in `schema.ts`, so it types as
        // `unknown`. Codegen WOULD type it from `vMessage` (it follows imported
        // validators since anolilab/lunora#651), but a typed column also validates
        // every write, and stored messages do not all match `vMessage` (e.g. a
        // tool-call part without `toolCallId`) — tried 2026-10-07: four tests and
        // one type check failed. `Message` is the shape this column has always held;
        // the read is narrowed here rather than left to `?.` on an `unknown`.
        if (!(message.message as Message | undefined)?.content.length) {
            const messages = await getStreamingMessagesWithMetadata(ctx, message, result);

            if (messages.length > 0) {
                await addMessagesHandler(ctx, {
                    agentName: message.agentName ?? undefined,
                    embeddings: undefined,
                    failPendingSteps: false,
                    messages,
                    pendingMessageId: messageId,
                    threadId: message.threadId,
                    userId: message.userId ?? undefined,
                });

                return null;
            }
        }

        if (result.status === "failed") {
            if (message.embeddingId) {
                await ctx.db.delete(message.embeddingId as Id<"embeddings_1536">);
            }

            // Vector deleted above, so the field is removed rather than left dangling.
            await patchRow(ctx.db, message, { embeddingId: undefined, error: result.error, status: "failed" });
        } else {
            await ctx.db.patch(messageId, { status: "success" });
        }

        return null;
    });

export const updateMessage = internalMutation
    .input({
        messageId: v.id("messages"),
        patch: v.object(partial(pick(vMessageDocFields, ["message", "fileIds", "status", "error", "model", "provider", "providerOptions", "finishReason"]))),
    })
    .output(v.from(vMessageDocument))
    .mutation(async ({ args, ctx }) => {
        const message = await ctx.db.get(args.messageId);

        assert(message, `Message ${args.messageId} not found`);

        if (args.patch.fileIds) {
            await changeRefcount(ctx, message.fileIds ?? [], args.patch.fileIds as unknown as Id<"chatFiles">[]); // fileIds may be typed as string[] from validator
        }

        // `omit(args.patch, ["_id", "_creationTime"])`: the patch validator is
        // derived from the full message doc, so it carries the system fields, and
        // its `_id` is a plain `string` where the Doc wants `Id<"messages">`. They
        // are not patchable anyway — spreading them in was writing the row's own
        // id back over itself.
        // Absent keys stay as they are; `embeddingId: undefined` below REMOVES
        // the field, which `patchRow` does by replacing the row.
        const patch: Partial<Doc<"messages">> = withoutUndefined(omit(args.patch, ["_id", "_creationTime"])) as Partial<Doc<"messages">>;

        if (args.patch.message !== undefined) {
            patch.message = args.patch.message;
            patch.tool = isTool(args.patch.message);
            patch.text = extractText(args.patch.message);
        }

        if (args.patch.status === "failed") {
            if (message.embeddingId) {
                await ctx.db.delete(message.embeddingId as Id<"embeddings_1536">);
            }

            patch.embeddingId = undefined;
        }

        await patchRow(ctx.db, message, patch);

        return publicMessage((await ctx.db.get(args.messageId))!);
    });

export const patchMessageTiming = internalMutation
    .input({
        durationMs: v.number(),
        messageId: v.id("messages"),
        ttftMs: v.optional(v.number()),
    })
    .mutation(async ({ args, ctx }) => {
        const message = await ctx.db.get(args.messageId);

        if (!message) {
            return;
        }

        // No cast: `usage`'s token counts are optional in the schema precisely
        // because this writer can run before any are known, producing a usage row
        // that holds only timings. See the note on `messages.usage` in the
        // generator's NARROWED_COLUMNS.
        await ctx.db.patch(args.messageId, {
            usage: {
                ...message.usage,
                durationMs: args.durationMs,
                ...(args.ttftMs !== undefined && { ttftMs: args.ttftMs }),
            },
        });
    });

export const cloneMessageBatch = internalMutation
    .input({
        copyUserIdForVectorSearch: v.optional(v.boolean()),
        excludeToolMessages: v.optional(v.boolean()),
        insertAtOrder: v.optional(v.number()),
        paginationOpts: paginationOptionsValidator,
        sourceThreadId: v.id("threads"),
        statuses: v.optional(v.array(vMessageStatus)),
        targetThreadId: v.id("threads"),
        upToAndIncludingMessageId: v.optional(v.id("messages")),
    })
    // Without an `.output()` the generated reference returns `unknown`, so the
    // `copyMessages` loop below had to annotate the result by hand and then failed
    // to assign it. Declared, so the caller gets the type from the api.
    .output(v.object({ continueCursor: v.union(v.string(), v.null()), isDone: v.boolean(), numCopied: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const orderOffset = args.insertAtOrder ?? 0;
        const result = await listMessagesByThreadIdHandler(ctx, {
            excludeToolMessages: args.excludeToolMessages,
            order: "desc",
            paginationOpts: args.paginationOpts,
            statuses: args.statuses,
            threadId: args.sourceThreadId,
            upToAndIncludingMessageId: args.upToAndIncludingMessageId,
        });

        // A branched source forks as the path its owner is looking at, written
        // as a straight line: the copy's explicit parents would name source ids.
        const sourceThread = await ctx.db.get(args.sourceThreadId);
        let activePath: Set<string> | undefined;

        if (sourceThread?.activeLeafMessageId) {
            const { tree } = await loadBranchTree(ctx, args.sourceThreadId);

            activePath = new Set(resolveActivePath(tree, sourceThread.activeLeafMessageId));
        }

        // The list cuts by `order` alone — a whole turn. A fork names its last
        // row exactly (`resolveForkEnd`), so a fork at a prompt leaves its reply.
        const lastToCopy = args.upToAndIncludingMessageId ? await ctx.db.get(args.upToAndIncludingMessageId) : null;
        const firstMessage = result.page[0];
        const lastMessage = result.page.at(-1);

        const existing =
            !firstMessage || !lastMessage
                ? []
                : await mergedStream<Doc<"messages">>(
                      [true, false].flatMap((tool) =>
                          messageStatuses.map((status) =>
                              stream(ctx.db)
                                  .query<Doc<"messages">>("messages")
                                  .withIndex("threadId_status_tool_order_stepOrder", (q) =>
                                      q
                                          .eq("threadId", args.targetThreadId)
                                          .eq("status", status)
                                          .eq("tool", tool)
                                          .gte("order", firstMessage.order)
                                          .lte("order", lastMessage.order),
                                  ),
                          ),
                      ),
                      ["order", "stepOrder"],
                  ).collect();

        await Promise.all(
            result.page
                .filter((m) => !activePath || activePath.has(m._id))
                .filter((m) => !lastToCopy || m.order < lastToCopy.order || m.stepOrder <= lastToCopy.stepOrder)
                .filter((m) => existing.every((existingMessage) => !(existingMessage.order === m.order && existingMessage.stepOrder === m.stepOrder)))
                .map(async (m) => {
                    if (m.fileIds) {
                        await changeRefcount(ctx, [], m.fileIds);
                    }

                    let embeddingId: VectorTableId | undefined;

                    if (m.embeddingId) {
                        const vector = (await ctx.db.get(m.embeddingId as unknown as VectorTableId)) as unknown as {
                            model: string;
                            table: string;
                            userId?: string;
                            vector: number[];
                        } | null;

                        assert(vector, `Vector ${m.embeddingId} not found`);
                        const dimension = vector.vector.length;

                        validateVectorDimension(dimension);
                        embeddingId = await insertVector(ctx, dimension, {
                            model: vector.model,
                            table: vector.table,
                            threadId: args.targetThreadId,
                            userId: args.copyUserIdForVectorSearch ? vector.userId : undefined,
                            vector: vector.vector,
                        });
                    }

                    await ctx.db.insert("messages", {
                        ...omit(m as unknown as Doc<"messages">, ["_id", "_creationTime", "threadId", "order", "embeddingId", "parentMessageId"]),
                        embeddingId,
                        order: orderOffset + m.order,
                        threadId: args.targetThreadId,
                    });
                }),
        );

        return {
            continueCursor: result.continueCursor,
            isDone: result.isDone,
            numCopied: result.page.length,
        };
    });

export const cloneThread = internalAction
    .input({
        batchSize: v.optional(v.number()),
        copyUserIdForVectorSearch: v.optional(v.boolean()),
        excludeToolMessages: v.optional(v.boolean()),
        insertAtOrder: v.optional(v.number()),
        limit: v.optional(v.number()),
        sourceThreadId: v.id("threads"),
        statuses: v.optional(v.array(vMessageStatus)),
        targetThreadId: v.id("threads"),
        upToAndIncludingMessageId: v.optional(v.id("messages")),
    })
    .output(v.number())
    .action(async ({ args, ctx }) => {
        let cursor: string | null = null;
        let copiedSoFar = 0;

        while (copiedSoFar < (args.limit ?? Infinity)) {
            const numberToCopy = Math.min(args.batchSize ?? DEFAULT_RECENT_MESSAGES, args.limit ?? Infinity - copiedSoFar);
            // Annotated because `cursor` below is fed from `result.continueCursor`,
            // which makes the inference circular ("implicitly has type 'any'").
            const result: { continueCursor: null | string; isDone: boolean; numCopied: number } = await ctx.runMutation(
                internal.agent.messages.cloneMessageBatch,
                {
                    ...args,
                    paginationOpts: {
                        cursor,
                        numItems: numberToCopy,
                    },
                },
            );

            copiedSoFar += result.numCopied;
            cursor = result.continueCursor;

            if (result.isDone) {
                break;
            }
        }

        return copiedSoFar;
    });

export const listMessagesByThreadIdArgs = {
    excludeToolMessages: v.optional(v.boolean()),
    order: v.union(v.literal("asc"), v.literal("desc")),
    paginationOpts: v.optional(paginationOptionsValidator),
    statuses: v.optional(v.array(vMessageStatus)),
    threadId: v.id("threads"),
    upToAndIncludingMessageId: v.optional(v.id("messages")),
};

export const listMessagesByThreadId = query
    .input(listMessagesByThreadIdArgs)
    .output(v.from(vPaginationResult(vMessageDocument)))
    .query(async ({ args, ctx }) => {
        // Owner or unexpired invitee only — see `thread-read-access.ts` for why
        // `isPublic` is not a grant on these raw rows.
        const identity = await getAuthUserIdentity(ctx);
        const access = await resolveThreadReadAccess(ctx, args.threadId, identity?.userId);

        if (access?.kind !== "full") {
            return { continueCursor: "" as string, isDone: true, page: [] };
        }

        const messages = await listMessagesByThreadIdHandler(ctx, args);

        return { ...messages, page: (messages.page as unknown as Doc<"messages">[]).map((item) => publicMessage(item)) };
    });

/**
 * Server-side twin of `listMessagesByThreadId`, with NO caller check.
 *
 * For code that has already authorized the thread — the agent loop, context
 * search, the GDPR export. Those often run with no user identity at all
 * (scheduled actions, workflow steps), where the public query answers an empty
 * page — which is how GDPR exports shipped without a single message.
 */
export const listMessagesByThreadIdInternal = internalQuery
    .input(listMessagesByThreadIdArgs)
    .output(v.from(vPaginationResult(vMessageDocument)))
    .query(async ({ args, ctx }) => {
        const messages = await listMessagesByThreadIdHandler(ctx, args);

        return { ...messages, page: (messages.page as unknown as Doc<"messages">[]).map((item) => publicMessage(item)) };
    });

/**
 * Direct handler for listing messages by thread ID.
 * Exported for use by hot-path queries (e.g. getThreadUIMessages) that need
 * to bypass the runQuery overhead (argument/return validation against vMessageDoc).
 */
export const listMessagesByThreadIdHandler = async (
    context: QueryContext,
    args: InferArgs<typeof listMessagesByThreadIdArgs>,
): Promise<PaginationResult<Doc<"messages">>> => {
    const allStatuses = messageStatuses;
    const statuses = args.statuses ?? allStatuses;
    const last = args.upToAndIncludingMessageId && (await context.db.get(args.upToAndIncludingMessageId));

    assert(!last || last.threadId === args.threadId, "upToAndIncludingMessageId must be a message in the thread");
    const toolOptions = args.excludeToolMessages ? [false] : [true, false];
    const order = args.order ?? "desc";

    // Fast path: when all statuses AND all tool types are requested (the common listUIMessages case),
    // use a single index scan instead of 6 merged streams
    const isAllStatusesRequested = statuses.length === allStatuses.length && allStatuses.every((s) => statuses.includes(s));
    const isAllToolsRequested = toolOptions.length === 2;

    let queryStream;
    const database = admittedThreadDb(context, args.threadId);

    if (isAllStatusesRequested && isAllToolsRequested) {
        queryStream = stream(database)
            .query<Doc<"messages">>("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => {
                const qq = q.eq("threadId", args.threadId);

                if (last) {
                    return qq.lte("order", last.order);
                }

                return qq;
            })
            .order(order);
        // Note: Removed redundant filterWith - the index query already filters by lte("order")
    } else {
        const streams = toolOptions.flatMap((tool) =>
            statuses.map(
                (status) =>
                    stream(database)
                        .query<Doc<"messages">>("messages")
                        .withIndex("threadId_status_tool_order_stepOrder", (q) => {
                            const qq = q.eq("threadId", args.threadId).eq("status", status).eq("tool", tool);

                            if (last) {
                                return qq.lte("order", last.order);
                            }

                            return qq;
                        })
                        .order(order),
                // Note: Removed redundant filterWith - the index query already filters by lte("order")
            ),
        );

        queryStream = mergedStream<Doc<"messages">>(streams, ["order", "stepOrder"]);
    }

    const messages = await queryStream.paginate(
        args.paginationOpts ?? {
            cursor: null,
            numItems: DEFAULT_RECENT_MESSAGES,
        },
    );

    if (messages.page.length === 0) {
        messages.isDone = true;
    }

    return messages;
};

export const getMessagesByIds = internalQuery
    .input({ messageIds: v.array(v.id("messages")) })
    .output(v.from(v.array(v.union(v.null(), vMessageDocument))))
    .query(async ({ args, ctx }) => {
        const rows = await Promise.all(args.messageIds.map((id) => ctx.db.get(id)));

        return rows.map((m) => (m ? publicMessage(m) : null));
    });

export const searchMessages = internalAction
    .input({
        embedding: v.optional(v.array(v.number())),
        embeddingModel: v.optional(v.string()),
        limit: v.number(),
        messageRange: v.optional(v.object({ after: v.number(), before: v.number() })),
        searchAllMessagesForUserId: v.optional(v.string()),
        targetMessageId: v.optional(v.id("messages")),
        text: v.optional(v.string()),
        textSearch: v.optional(v.boolean()),
        threadId: v.optional(v.id("threads")),
        vectorScoreThreshold: v.optional(v.number()),
        vectorSearch: v.optional(v.boolean()),
    })
    .output(v.from(v.array(vMessageDocument)))
    .action(async ({ args, ctx }) => {
        assert(args.searchAllMessagesForUserId || args.threadId, "Specify userId or threadId");
        const { limit } = args;
        let textSearchMessages: MessageDoc[] | undefined;

        if (args.textSearch) {
            textSearchMessages = await ctx.runQuery(internal.agent.messages.textSearch, {
                limit,
                searchAllMessagesForUserId: args.searchAllMessagesForUserId,
                targetMessageId: args.targetMessageId,
                text: args.text,
                threadId: args.threadId,
            });
        }

        if (args.vectorSearch) {
            let { embedding } = args;
            let model = args.embeddingModel;

            if (!embedding && args.targetMessageId) {
                const target = await ctx.runQuery(internal.agent.messages.getMessageSearchFields, {
                    messageId: args.targetMessageId,
                });

                assert(target, "Target message embedding not found.");
                embedding = target.embedding;
                model = target.embeddingModel;
            }

            assert(embedding && model, "Embedding missing");
            const dimension = embedding.length;

            validateVectorDimension(dimension);
            const searchedVectors = await searchVectors(ctx, embedding, {
                dimension,
                limit,
                model,
                searchAllMessagesForUserId: args.searchAllMessagesForUserId,
                table: "messages",
                threadId: args.threadId,
            });
            const vectors = searchedVectors.filter((vector) => vector._score > (args.vectorScoreThreshold ?? 0));

            const k = 10;
            const textEmbeddingIds = textSearchMessages?.map((m) => m.embeddingId);
            const vectorScores = vectors
                .map((vector, i) => {
                    return {
                        id: vector._id,
                        score: 1 / (i + k) + 1 / ((textEmbeddingIds?.indexOf(vector._id) ?? Infinity) + k),
                    };
                })
                .toSorted((a, b) => b.score - a.score);
            const embeddingIds = vectorScores.slice(0, limit).map((vector) => vector.id);
            const messages: MessageDoc[] = await ctx.runQuery(internal.agent.messages._fetchSearchMessages, {
                beforeMessageId: args.targetMessageId,
                embeddingIds,
                limit,
                messageRange: args.messageRange ?? DEFAULT_MESSAGE_RANGE,
                searchAllMessagesForUserId: args.searchAllMessagesForUserId,
                textSearchMessages: textSearchMessages?.filter((m) => !embeddingIds.includes(m.embeddingId! as VectorTableId)),
                threadId: args.threadId,
            });

            return messages;
        }

        return textSearchMessages?.flat() ?? [];
    });

export const _fetchSearchMessages = internalQuery
    .input({
        beforeMessageId: v.optional(v.id("messages")),
        embeddingIds: v.array(vVectorId),
        limit: v.number(),
        messageRange: v.object({ after: v.number(), before: v.number() }),
        searchAllMessagesForUserId: v.optional(v.string()),
        textSearchMessages: v.optional(v.array(vMessageDocument)),
        threadId: v.optional(v.id("threads")),
    })
    .output(v.from(v.array(vMessageDocument)))
    .query(async ({ args, ctx }) => {
        const beforeMessage = args.beforeMessageId && (await ctx.db.get(args.beforeMessageId));
        const { searchAllMessagesForUserId, threadId } = args;

        assert(searchAllMessagesForUserId || threadId, "Specify searchAllMessagesForUserId or threadId to search");
        const matchedMessages = await Promise.all(
            args.embeddingIds.map((embeddingId) =>
                ctx.db
                    .query("messages")
                    .withIndex("embeddingId_threadId", (q) =>
                        searchAllMessagesForUserId ? q.eq("embeddingId", embeddingId) : q.eq("embeddingId", embeddingId).eq("threadId", threadId!),
                    )
                    .filter(
                        (document) =>
                            document.status === "success" &&
                            (searchAllMessagesForUserId ? document.userId === searchAllMessagesForUserId : document.threadId === threadId),
                    )
                    .first(),
            ),
        );
        let messages: MessageDoc[] = matchedMessages
            .filter(
                (m): m is Doc<"messages"> =>
                    m !== undefined &&
                    m !== null &&
                    !m.tool &&
                    (!beforeMessage || m.order < beforeMessage.order || (m.order === beforeMessage.order && m.stepOrder < beforeMessage.stepOrder)),
            )
            .map((item) => publicMessage(item));

        messages.push(...(args.textSearchMessages ?? []));
        messages = sorted(messages);
        messages = messages.slice(0, args.limit);

        if (!threadId) {
            return messages;
        }

        const included: Record<string, Set<number>> = {};

        for (const m of messages) {
            const searchId = m.threadId ?? m.userId!;

            included[searchId] ??= new Set();

            const seenOrders = included[searchId];

            seenOrders.add(m.order!);
        }

        const ranges: Record<string, Doc<"messages">[]> = {};
        const { after, before } = args.messageRange;

        for (const m of messages) {
            const searchId = m.threadId ?? m.userId!;
            const order = m.order!;
            let includedSet = included[searchId];

            if (!includedSet) {
                includedSet = new Set();
                included[searchId] = includedSet;
            }

            let earliest = order - before;
            let latest = order + after;

            for (; earliest <= latest; earliest += 1) {
                if (!includedSet.has(earliest)) {
                    break;
                }
            }

            for (; latest >= earliest; latest -= 1) {
                if (!includedSet.has(latest)) {
                    break;
                }
            }

            for (let i = earliest; i <= latest; i += 1) {
                includedSet.add(i);
            }

            if (earliest !== latest) {
                const surrounding = await ctx.db
                    .query("messages")
                    .withIndex("threadId_status_tool_order_stepOrder", (q) =>
                        q
                            .eq("threadId", m.threadId as Id<"threads">)
                            .eq("status", "success")
                            .eq("tool", false)
                            .gte("order", earliest)
                            .lte("order", latest),
                    )
                    .take(20);

                ranges[searchId] ??= [];

                const range = ranges[searchId];

                range.push(...surrounding);
            }
        }

        for (const r of Object.values(ranges).flat()) {
            if (messages.every((m) => m._id !== r._id)) {
                messages.push(publicMessage(r));
            }
        }

        return sorted(messages);
    });

export const textSearch = internalQuery
    .input({
        limit: v.number(),
        searchAllMessagesForUserId: v.optional(v.string()),
        targetMessageId: v.optional(v.id("messages")),
        text: v.optional(v.string()),
        threadId: v.optional(v.id("threads")),
    })
    .output(v.from(v.array(vMessageDocument)))
    .query(async ({ args, ctx }) => {
        assert(args.searchAllMessagesForUserId || args.threadId, "Specify userId or threadId");
        const targetMessage = args.targetMessageId && (await ctx.db.get(args.targetMessageId));
        const order = targetMessage?.order;
        const text = args.text || targetMessage?.text;

        if (!text) {
            console.warn("No text to search", targetMessage, args.text);

            return [];
        }

        const messages = await ctx.db
            .query("messages")
            .withSearchIndex("text_search", (q) =>
                args.searchAllMessagesForUserId
                    ? q.search("text", text).eq("userId", args.searchAllMessagesForUserId)
                    : q.search("text", text).eq("threadId", args.threadId!),
            )
            .filter((document) => document.tool === false && (order ? document.order <= order : true))
            .take(args.limit);

        return messages
            .filter((m) => !targetMessage || m.order < targetMessage.order || (m.order === targetMessage.order && m.stepOrder < targetMessage.stepOrder))
            .map((item) => publicMessage(item));
    });

export const getMessageSearchFields = internalQuery
    .input({
        messageId: v.id("messages"),
    })
    .output(
        v.object({
            embedding: v.optional(v.array(v.number())),
            embeddingModel: v.optional(v.string()),
            text: v.optional(v.string()),
        }),
    )
    .query(async ({ args, ctx }) => {
        const message = await ctx.db.get(args.messageId);
        const text = message?.text;
        let embedding;
        let embeddingModel;

        if (message?.embeddingId) {
            const target = (await ctx.db.get(message.embeddingId as unknown as VectorTableId)) as unknown as { model: string; vector: number[] } | null;

            embedding = target?.vector;
            embeddingModel = target?.model;
        }

        return {
            embedding,
            embeddingModel,
            text: text ?? undefined,
        };
    });
