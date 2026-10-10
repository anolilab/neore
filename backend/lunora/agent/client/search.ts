import { type EmbeddingModel, embedMany as embedMany_, type ModelMessage } from "ai";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import { assert } from "../../lib/error-helpers";
import { docsToModelMessages, toModelMessage } from "../mapping";
import { DEFAULT_MESSAGE_RANGE, DEFAULT_RECENT_MESSAGES, extractText, getModelName, getProviderName, isTool, sorted } from "../shared";
import type { MessageDoc as MessageDocument } from "../validators";
import type { Message } from "../validators";
import { validateVectorDimension, type VectorDimension } from "../vector/tables";
import { issuedStorageOrigins } from "../../lib/storage-ref";
import { signedReadUrl } from "../../lib/storage-read";
import { resolveDocsStoredMedia } from "../stored-media";
import { inlineMessagesFiles, isLocalOrigin } from "./files";
import type {
    ActionCtx as ActionContext,
    AgentComponent,
    Config,
    ContextOptions,
    MutationCtx as MutationContext,
    Options,
    QueryCtx as QueryContext,
    RunnerCtx as RunnerContext,
} from "./types";

const DEFAULT_VECTOR_SCORE_THRESHOLD = 0;
// 10k characters should be more than enough for most cases, and stays under
// the 8k token limit for some models.
const MAX_EMBEDDING_TEXT_LENGTH = 10_000;

export type GetEmbedding = (text: string) => Promise<{
    embedding: number[];
    embeddingModel: EmbeddingModel;
}>;

/**
 * Fetch the context messages for a thread.
 * @param ctx Either a query, mutation, or action ctx.
 * If it is not an action context, you can't do text or
 * vector search.
 * @returns
 */
export const fetchContextMessages = async (
    ctx: QueryContext | MutationContext | ActionContext,
    component: AgentComponent,
    args: {
        contextOptions: ContextOptions;
        getEmbedding?: GetEmbedding;

        /**
         * If targetMessageId is not provided, this text will be used
         * for text and vector search
         */
        searchText?: string;

        /**
         * If provided, it will use this message for text/vector search (if enabled)
         * and will only fetch messages up to (and including) this message's "order"
         */
        targetMessageId?: string;
        threadId: string | undefined;
        userId: string | undefined;
    },
): Promise<MessageDocument[]> => {
    const { recentMessages, searchMessages } = await fetchRecentAndSearchMessages(ctx, component, args);

    return [...searchMessages, ...recentMessages];
};

export const fetchRecentAndSearchMessages = async (
    context: QueryContext | MutationContext | ActionContext,
    // Kept for the call signature; reads go through `internal` now.
    _component: AgentComponent,
    args: {
        contextOptions: ContextOptions;
        getEmbedding?: GetEmbedding;

        /**
         * If targetMessageId is not provided, this text will be used
         * for text and vector search
         */
        searchText?: string;

        /**
         * If provided, it will use this message for text/vector search (if enabled)
         * and will only fetch messages up to (and including) this message's "order"
         */
        targetMessageId?: string;
        threadId: string | undefined;
        userId: string | undefined;
    },
): Promise<{ recentMessages: MessageDocument[]; searchMessages: MessageDocument[] }> => {
    assert(args.userId || args.threadId, "Specify userId or threadId");
    const options = args.contextOptions;
    // Fetch the latest messages from the thread
    let included: Set<string> | undefined;
    let recentMessages: MessageDocument[] = [];
    let searchMessages: MessageDocument[] = [];
    const { targetMessageId } = args;
    // A branched thread holds sibling replies and edited prompts; only the
    // prompt's own path is history. `null` = unbranched, every row counts.
    const pathIds =
        args.threadId && targetMessageId
            ? await context.runQuery(internal.agent.branches.getContextPathIds, {
                  promptMessageId: targetMessageId as Id<"messages">,
                  threadId: args.threadId as Id<"threads">,
              })
            : null;
    const onPath = pathIds ? new Set(pathIds) : undefined;

    if (args.threadId && options.recentMessages !== 0) {
        // Internal for the same reason as `listMessages`: the thread is already
        // authorized, and background runs carry no identity.
        const { page } = await context.runQuery(internal.agent.messages.listMessagesByThreadIdInternal, {
            excludeToolMessages: options.excludeToolMessages,
            order: "desc",
            paginationOpts: {
                cursor: null,
                numItems: options.recentMessages ?? DEFAULT_RECENT_MESSAGES,
            },
            statuses: ["success"],
            threadId: args.threadId as Id<"threads">,
            upToAndIncludingMessageId: targetMessageId as Id<"messages"> | undefined,
        });

        const pathPage = onPath ? page.filter((m) => onPath.has(m._id)) : page;

        included = new Set(pathPage.map((m) => m._id));
        recentMessages = filterOutOrphanedToolMessages(sorted(pathPage));
    }

    if ((options.searchOptions?.textSearch || options.searchOptions?.vectorSearch) && options.searchOptions?.limit) {
        if (!("runAction" in context)) {
            throw new Error("searchUserMessages only works in an action");
        }

        let text = args.searchText;
        let embedding: number[] | undefined;
        let embeddingModel: string | undefined;

        if (!text) {
            if (targetMessageId) {
                const targetMessage = recentMessages.find((m) => m._id === targetMessageId);

                if (targetMessage) {
                    text = targetMessage.text;
                } else {
                    const targetSearchFields = await context.runQuery(internal.agent.messages.getMessageSearchFields, {
                        messageId: targetMessageId as Id<"messages">,
                    });

                    text = targetSearchFields.text;
                    embedding = targetSearchFields.embedding;
                    embeddingModel = targetSearchFields.embeddingModel;
                }

                assert(text, "Target message has no text for searching");
            }

            assert(text, "No text to search - provide searchText or targetMessageId");
        }

        if (options.searchOptions?.vectorSearch && !embedding && args.getEmbedding) {
            const embeddingFields = await args.getEmbedding(text);

            embedding = embeddingFields.embedding;
            embeddingModel = getModelName(embeddingFields.embeddingModel);
            // TODO: if the text matches the target message, save the embedding
            // for the target message and return the embeddingId on the message.
        }

        // The thread read is hoisted out of the `??` chain rather than awaited inline.
        // The guard reproduces the short-circuit exactly.
        const shouldReadThreadUser = Boolean(options?.searchOtherThreads) && args.userId === undefined && Boolean(args.threadId);
        const threadForUserId = shouldReadThreadUser
            ? await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: args.threadId as Id<"threads"> })
            : undefined;

        const searchResults = await context.runAction(internal.agent.messages.searchMessages, {
            embedding,
            embeddingModel,
            limit: options.searchOptions?.limit ?? 10,
            messageRange: {
                ...DEFAULT_MESSAGE_RANGE,
                ...options.searchOptions?.messageRange,
            },
            searchAllMessagesForUserId: options?.searchOtherThreads ? (args.userId ?? (args.threadId && threadForUserId?.userId)) : undefined,
            targetMessageId: targetMessageId as Id<"messages"> | undefined,
            text,
            textSearch: options.searchOptions?.textSearch,
            threadId: args.threadId as Id<"threads"> | undefined,
            vectorScoreThreshold: options.searchOptions?.vectorScoreThreshold ?? DEFAULT_VECTOR_SCORE_THRESHOLD,
            vectorSearch: options.searchOptions?.vectorSearch,
        });

        // TODO: track what messages we used for context
        searchMessages = filterOutOrphanedToolMessages(
            sorted(searchResults.filter((m) => !included?.has(m._id) && (!onPath || m.threadId !== args.threadId || onPath.has(m._id)))),
        );
    }

    // Ensure we don't include tool messages without a corresponding tool call
    return { recentMessages, searchMessages };
};

/**
 * Filter out tool messages that don't have both a tool call and response.
 * Also filters out tool approval requests/responses that don't have corresponding tool calls/results.
 * @param docs The messages to filter.
 * @returns The filtered messages.
 */
export const filterOutOrphanedToolMessages = (docs: MessageDocument[]) => {
    const toolCallIds = new Set<string>();
    const toolResultIds = new Set<string>();
    const approvalRequestIds = new Set<string>();
    const approvalResponseIds = new Set<string>();
    // Map from toolCallId to approvalId for finding approved tool calls
    const toolCallIdToApprovalId = new Map<string, string>();
    const result: MessageDocument[] = [];

    // First pass: collect all IDs and mappings
    for (const documentRow of docs) {
        if (documentRow.message && Array.isArray(documentRow.message.content)) {
            for (const content of documentRow.message.content) {
                switch (content.type) {
                    case "tool-approval-request": {
                        approvalRequestIds.add(content.approvalId);
                        toolCallIdToApprovalId.set(content.toolCallId, content.approvalId);

                        break;
                    }
                    case "tool-approval-response": {
                        approvalResponseIds.add(content.approvalId);

                        break;
                    }
                    case "tool-call": {
                        toolCallIds.add(content.toolCallId);

                        break;
                    }
                    case "tool-result": {
                        toolResultIds.add(content.toolCallId);

                        break;
                    }
                    // No default
                    default: {
                        break;
                    }
                }
            }
        }
    }

    // Determine which tool calls have approved responses
    const approvedToolCallIds = new Set<string>();

    for (const [toolCallId, approvalId] of toolCallIdToApprovalId) {
        if (approvalResponseIds.has(approvalId)) {
            approvedToolCallIds.add(toolCallId);
        }
    }

    for (const documentRow of docs) {
        if (documentRow.message?.role === "assistant" && Array.isArray(documentRow.message.content)) {
            const content = documentRow.message.content.filter((p) => {
                if (p.type === "tool-call") {
                    // Keep tool-call if it has a result OR an approved approval response
                    return toolResultIds.has(p.toolCallId) || approvedToolCallIds.has(p.toolCallId);
                }

                // Keep approval-requests (they're informational even without a response)
                // Keep all other content types
                return true;
            });

            if (content.length > 0) {
                result.push({
                    ...documentRow,
                    message: {
                        ...documentRow.message,
                        content,
                    },
                });
            }
        } else if (documentRow.message?.role === "tool") {
            const content = documentRow.message.content.filter((c) => {
                // Tool content can be tool-result (has toolCallId) or tool-approval-response (has approvalId)
                if (c.type === "tool-result") {
                    return toolCallIds.has(c.toolCallId);
                }

                if (c.type === "tool-approval-response") {
                    return approvalRequestIds.has(c.approvalId);
                }

                return true;
            });

            if (content.length > 0) {
                result.push({
                    ...documentRow,
                    message: {
                        ...documentRow.message,
                        content,
                    },
                });
            }
        } else if (documentRow.message?.role === "user" && Array.isArray(documentRow.message.content)) {
            // User content parts don't include tool-approval-response in the type,
            // but we keep this check for compatibility in case it appears
            const content = documentRow.message.content.filter((c) => {
                const part = c as { approvalId?: string; type: string };

                return part.type !== "tool-approval-response" || approvalRequestIds.has(part.approvalId ?? "");
            });

            if (content.length > 0) {
                result.push({
                    ...documentRow,
                    message: {
                        ...documentRow.message,
                        content,
                    },
                });
            }
        } else {
            result.push(documentRow);
        }
    }

    return result;
};

/**
 * Embed a list of messages, including calling any usage handler.
 * This will not save the embeddings to the database.
 */
export const embedMessages = async (
    context: ActionContext | RunnerContext,
    {
        threadId,
        userId,
        ...options
    }: Pick<Config, "usageHandler" | "embeddingModel" | "callSettings"> & {
        agentName?: string;
        threadId: string | undefined;
        userId: string | undefined;
    },
    messages: (ModelMessage | Message)[],
): Promise<
    | {
          dimension: VectorDimension;
          model: string;
          vectors: (number[] | null)[];
      }
    | undefined
> => {
    if (!options.embeddingModel) {
        return undefined;
    }

    const messageTexts = messages.map((m) => !isTool(m) && extractText(m));
    // Find the indexes of the messages that have text.
    const textIndexes = messageTexts.map((t, i) => (t ? i : undefined)).filter((i) => i !== undefined);

    if (textIndexes.length === 0) {
        return undefined;
    }

    let embeddings:
        | {
              dimension: VectorDimension;
              model: string;
              vectors: (number[] | null)[];
          }
        | undefined;

    const values = messageTexts.map((t) => t && t.trim().slice(0, MAX_EMBEDDING_TEXT_LENGTH)).filter((t): t is string => !!t);
    // Then embed those messages.
    const textEmbeddings = await embedMany(context, {
        ...options,
        threadId,
        userId,
        values,
    });
    // Then assemble the embeddings into a single array with nulls for the messages without text.
    // One slot per message, annotated because the initial `null` fill infers
    // `null[]` where the old `Array(n)` inferred `any[]`; the slots for messages
    // that had text are overwritten below.
    const embeddingsOrNull: (number[] | null)[] = messages.map(() => null);

    textIndexes.forEach((i, j) => {
        // `?? null` keeps the "no embedding" slot as null rather than undefined.
        // `embeddings` is parallel to `textIndexes` by construction, so this should
        // never fire — but the array's contract is `number[] | null`, and the
        // previous `any[]` inference was the only thing hiding the difference.
        embeddingsOrNull[i] = textEmbeddings.embeddings[j] ?? null;
    });
    const firstEmbedding = textEmbeddings.embeddings[0];

    if (firstEmbedding) {
        const dimension = firstEmbedding.length;

        validateVectorDimension(dimension);
        const modelName = getModelName(options.embeddingModel);

        embeddings = { dimension, model: modelName, vectors: embeddingsOrNull };
    }

    return embeddings;
};

/**
 * Embeds many strings, calling any usage handler.
 * @param ctx The ctx parameter to an action.
 * @param args Arguments to AI SDK's embedMany, and context for the embedding,
 * passed to the usage handler.
 * @returns The embeddings for the strings, matching the order of the values.
 */
export const embedMany = async (
    ctx: ActionContext | RunnerContext,
    {
        abortSignal,
        agentName,
        callSettings,
        embeddingModel,
        headers,
        threadId,
        usageHandler,
        userId,
        values,
    }: Pick<Config, "usageHandler" | "embeddingModel" | "callSettings"> & {
        abortSignal?: AbortSignal;
        agentName?: string;
        headers?: Record<string, string>;
        threadId: string | undefined;
        userId: string | undefined;
        values: string[];
    },
): Promise<{ embeddings: number[][] }> => {
    assert(embeddingModel, "an embeddingModel is required for vector search");
    const result = await embedMany_({
        ...callSettings,
        abortSignal,
        headers,
        model: embeddingModel,
        values,
    });

    if (usageHandler && result.usage) {
        await usageHandler(ctx, {
            agentName,
            model: getModelName(embeddingModel),
            provider: getProviderName(embeddingModel),
            providerMetadata: undefined,
            threadId,
            usage: {
                inputTokenDetails: {
                    cacheReadTokens: undefined,
                    cacheWriteTokens: undefined,
                    noCacheTokens: undefined,
                },
                inputTokens: result.usage.tokens,
                outputTokenDetails: {
                    reasoningTokens: undefined,
                    textTokens: undefined,
                },
                outputTokens: 0,
                totalTokens: result.usage.tokens,
            },
            userId,
        });
    }

    return { embeddings: result.embeddings };
};

/**
 * Embed a list of messages, and save the embeddings to the database.
 * @param ctx The ctx parameter to an action.
 */
export const generateAndSaveEmbeddings = async (
    ctx: ActionContext,
    _component: AgentComponent,
    args: Pick<Config, "usageHandler" | "callSettings"> & {
        agentName?: string;
        embeddingModel: EmbeddingModel;
        threadId: string | undefined;
        userId: string | undefined;
    },
    messages: MessageDocument[],
) => {
    const toEmbed = messages.filter((m) => !m.embeddingId && m.message);

    if (toEmbed.length === 0) {
        return;
    }

    const embeddings = await embedMessages(
        ctx,
        args,
        toEmbed.map((m) => m.message!),
    );

    if (embeddings && embeddings.vectors.some((v) => v !== null)) {
        await ctx.runMutation(internal.agent.vector.insertBatch, {
            vectorDimension: embeddings.dimension,
            vectors: toEmbed
                .map((m, i) => {
                    return {
                        messageId: m._id as Id<"messages"> | undefined,
                        model: embeddings.model,
                        table: "messages" as const,
                        threadId: m.threadId,
                        userId: m.userId,
                        vector: embeddings.vectors[i],
                    };
                })
                .filter((v): v is typeof v & { vector: number[] } => v.vector != null),
        });
    }
};

/**
 * Similar to fetchContextMessages, but also combines the input messages,
 * with search context, recent messages, input messages, then prompt messages.
 * If there is a promptMessageId and prompt message(s) provided, it will splice
 * the prompt messages into the history to replace the promptMessageId message,
 * but still be followed by any existing messages that were in response to the
 * promptMessageId message.
 */
export const fetchContextWithPrompt = async (
    context: ActionContext,
    component: AgentComponent,
    args: Config &
        Options & {
            agentName?: string;
            messages: (ModelMessage | Message)[] | undefined;
            prompt: string | (ModelMessage | Message)[] | undefined;
            promptMessageId: string | undefined;
            statelessMode?: boolean; // If true, skip all context fetching
            threadId: string | undefined;
            userId: string | undefined;
        },
): Promise<{
    messages: ModelMessage[];
    order: number | undefined;
    stepOrder: number | undefined;
}> => {
    const { embeddingModel, statelessMode, threadId, userId } = args;

    // If stateless mode is enabled, return ONLY the current input messages
    // No search context, no recent messages, no existing responses
    if (statelessMode) {
        const promptArray = getPromptArray(args.prompt);
        const inputMessages = (args.messages ?? []).map((item) => toModelMessage(item));
        const inputPrompt = promptArray.map((item) => toModelMessage(item));

        // Return only the current input, no context
        return {
            messages: [...inputMessages, ...inputPrompt],
            order: undefined,
            stepOrder: undefined,
        };
    }

    const promptArray = getPromptArray(args.prompt);

    const lastArgumentMessage = args.messages?.at(-1);
    let searchText: string | undefined;

    if (promptArray.length > 0) {
        searchText = extractText(promptArray.at(-1)!);
    } else if (!args.promptMessageId && lastArgumentMessage) {
        searchText = extractText(lastArgumentMessage);
    }

    // If only a messageId is provided, this will add that message to the end.
    const { recentMessages, searchMessages } = await fetchRecentAndSearchMessages(context, component, {
        contextOptions: args.contextOptions ?? {},
        getEmbedding: async (text) => {
            assert(embeddingModel, "An embeddingModel is required to be set on the Agent that you're doing vector search with");
            const result = await embedMany(context, {
                ...args,
                userId,
                values: [text],
            });
            const embedding = result.embeddings[0];

            if (!embedding) {
                throw new Error("Failed to generate embedding for text");
            }

            return { embedding, embeddingModel };
        },
        searchText,
        targetMessageId: args.promptMessageId,
        threadId,
        userId,
    });

    const promptMessageIndex = args.promptMessageId ? recentMessages.findIndex((m) => m._id === args.promptMessageId) : -1;
    const promptMessage = promptMessageIndex === -1 ? undefined : recentMessages[promptMessageIndex];
    let prePromptDocs = recentMessages;
    const messages = args.messages ?? [];
    let existingResponseDocs: MessageDocument[] = [];

    if (promptMessage) {
        prePromptDocs = recentMessages.slice(0, promptMessageIndex);
        existingResponseDocs = recentMessages.slice(promptMessageIndex + 1);

        // If they didn't override the prompt, use the existing prompt message.
        if (promptArray.length === 0 && promptMessage.message) {
            promptArray.push(promptMessage.message);
        }

        if (!promptMessage.embeddingId && embeddingModel) {
            // Lazily generate embeddings for the prompt message, if it doesn't have
            // embeddings yet. This can happen if the message was saved in a mutation
            // where the LLM is not available.
            await generateAndSaveEmbeddings(
                context,
                component,
                {
                    ...args,
                    embeddingModel,
                    userId,
                },
                [promptMessage],
            );
        }
    }

    // Attachments and generated media are persisted as storage references (or,
    // in older rows, URLs that have since expired). Sign them NOW, for this call
    // only, so every turn — follow-ups included — hands the model live links.
    const signForModel = async <D extends MessageDocument>(docs: D[]): Promise<D[]> =>
        await resolveDocsStoredMedia(docs, {
            lookupKeys: async (fileIds) =>
                new Map(Object.entries(await context.runQuery(internal.agent.files.getStorageKeys, { fileIds: fileIds as Id<"chatFiles">[] }))),
            lookupOwnedKeys: async (owner, keys) => new Set(await context.runQuery(internal.agent.files.getOwnedStorageKeys, { keys, userId: owner })),
            origins: issuedStorageOrigins(),
            sign: async (key) => await signedReadUrl(context.storage, key),
        });
    const [signedSearch, signedPrePrompt, signedExisting, signedPrompt] = await Promise.all([
        signForModel(searchMessages),
        signForModel(prePromptDocs),
        signForModel(existingResponseDocs),
        promptMessage ? signForModel([promptMessage]) : Promise.resolve([]),
    ]);

    // The prompt doc's message was pushed onto `promptArray` above; swap in the signed copy.
    if (promptMessage?.message && signedPrompt[0]?.message) {
        const promptIndex = promptArray.indexOf(promptMessage.message);

        if (promptIndex !== -1) {
            promptArray[promptIndex] = signedPrompt[0].message;
        }
    }

    const search = docsToModelMessages(signedSearch);
    const recent = docsToModelMessages(signedPrePrompt);
    const inputMessages = messages.map((item) => toModelMessage(item));
    const inputPrompt = promptArray.map((item) => toModelMessage(item));
    const existingResponses = docsToModelMessages(signedExisting);

    const allMessages = [...search, ...recent, ...inputMessages, ...inputPrompt, ...existingResponses];
    let processedMessages = args.contextHandler
        ? await args.contextHandler(context, {
              allMessages,
              existingResponses,
              inputMessages,
              inputPrompt,
              recent,
              search,
              threadId,
              userId,
          })
        : allMessages;

    // In local dev the signed URLs point at localhost, which no provider can
    // reach, so the bytes are inlined instead.
    if (isLocalOrigin(process.env.PUBLIC_ORIGIN)) {
        processedMessages = await inlineMessagesFiles(processedMessages);
    }

    return {
        messages: processedMessages,
        order: promptMessage?.order,
        stepOrder: promptMessage?.stepOrder,
    };
};

export const getPromptArray = (prompt: string | (ModelMessage | Message)[] | undefined): (ModelMessage | Message)[] => {
    if (!prompt) {
        return [];
    }

    return Array.isArray(prompt) ? prompt : [{ content: prompt, role: "user" }];
};
