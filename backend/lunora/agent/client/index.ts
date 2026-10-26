import type { ImageModelV3, JSONValue } from "@ai-sdk/provider";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { Context as AiContext } from "@ai-sdk/provider-utils";
import { type FlexibleSchema, getErrorMessage, type IdGenerator, type InferSchema } from "@ai-sdk/provider-utils";
import type {
    CallSettings,
    GenerateObjectResult,
    GenerateTextResult,
    LanguageModel,
    ModelMessage,
    StepResult,
    StopCondition,
    StreamTextResult,
    ToolChoice,
    ToolSet,
} from "ai";
import { generateText, stepCountIs } from "ai";
import type { ArgsOf } from "lunorash/client";
import type { PaginationOptions, PaginationResult } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../../_generated/internal";
// `internalActionGeneric` / `internalMutationGeneric` were the previous runtime's
// dataModel-agnostic builders, for code shipped as a library. This app owns its
// schema, so the generated builders are the right ones.
import { internalAction as internalActionGeneric, internalMutation as internalMutationGeneric } from "../../_generated/server";
import { compressContextMessages, getModelContextWindow, isContextExceededError } from "../../chat/lib/auto-continue";
import { omit, pick } from "../../lib/collections";
import { assert } from "../../lib/error-helpers";
import { toModelMessage } from "../mapping";
import { getModelName } from "../shared";
import {
    type Message,
    type MessageDoc,
    type MessageStatus,
    type MessageWithMetadata,
    type StreamArgs,
    type ThreadDoc,
    vSafeObjectArgsFields,
    vTextArgsFields,
} from "../validators";
import type { VectorDimension } from "../vector/tables";
import type { ContextRetryMarker, ReadableAgentContext, StreamObjectCompatResult, WritableAgentContext } from "./agent-types";
import { generateAndSaveEmbeddingsFor, saveMessagesFor, saveObjectFor, saveStepFor, updateMessageFor } from "./message-persistence";
import { listMessages, type SaveMessageArgs, type SaveMessagesArgs } from "./messages";
import { embedMany, embedMessages, fetchContextMessages } from "./search";
import startGeneration from "./start";
import streamText from "./stream-text";
import { generateObjectFor, streamObjectFor } from "./structured-output";
import { type StreamingOptions, syncStreams } from "./streaming";
import { approveToolCallFor, denyToolCallFor } from "./tool-approval";
import { createThread, getThreadMetadata } from "./threads";
import type {
    ActionCtx as ActionContext,
    AgentComponent,
    AgentPrompt,
    Config,
    ContextOptions,
    GenerateObjectArgs,
    GenerationOutputMetadata,
    MaybeCustomCtx as MaybeCustomContext,
    MutationCtx as MutationContext,
    ObjectMode,
    Options,
    Output,
    RunnerCtx,
    StreamingTextArgs,
    StreamObjectArgs,
    SyncStreamsReturnValue,
    TextArgs,
    Thread,
} from "./types";
import { asId, asIdArray, willContinue } from "./utilities";

export { deriveUIMessagesFromDeltas } from "../deltas";
export { docsToModelMessages, guessMimeType, serializeDataOrUrl, serializeMessage, toModelMessage, toUIFilePart } from "../mapping";
export { listMessagesByThreadIdHandler } from "../messages";
// NOTE: these are also exported via validators
// a future version may put them all here or move these over there
export { DEFAULT_MESSAGE_RANGE, DEFAULT_RECENT_MESSAGES, extractText, isTool, sorted } from "../shared";
export { listDeltasHandler, listHandler as listStreamsHandler } from "../streams";
export { fromUIMessages, type MessageUsage, toUIMessages, type UIMessage } from "../ui-messages";
export {
    type Message,
    type MessageDoc,
    type MessageStatus,
    type MessageWithMetadataInternal,
    type ProjectDoc,
    type ProviderMetadata,
    type SourcePart,
    type StreamArgs,
    type StreamDelta,
    type StreamMessage,
    type ThreadDoc,
    type Usage,
    vAssistantMessage,
    vContent,
    vContextOptions,
    vFinishReason,
    vLanguageModelCallWarning,
    vMessage,
    vMessageDoc,
    vMessageEmbeddingsWithDimension,
    vMessageStatus,
    vMessageWithMetadataInternal,
    vPaginationResult,
    vProjectDoc,
    vProviderMetadata,
    vProviderOptions,
    vReasoningDetails,
    vSource,
    vStorageOptions,
    vStreamArgs,
    vStreamDelta,
    vStreamMessage,
    vSystemMessage,
    vThreadDoc,
    vThreadStatus,
    vToolMessage,
    vUsage,
    vUserMessage,
} from "../validators";
export { createTool, type ToolCtx } from "./create-tool";
export { getFile, storeFile } from "./files";
export { listMessages, listUIMessages, saveMessage, type SaveMessageArgs, saveMessages, type SaveMessagesArgs } from "./messages";
export { embedMany, embedMessages, fetchContextMessages, fetchContextWithPrompt, filterOutOrphanedToolMessages, generateAndSaveEmbeddings } from "./search";
export { default as startGeneration } from "./start";
export {
    abortStream,
    compressUIMessageChunks,
    DEFAULT_STREAMING_OPTIONS,
    DeltaStreamer,
    listStreams,
    syncStreams,
    vStreamMessagesReturnValue,
} from "./streaming";
export { createThread, getThreadMetadata, searchThreadTitles, updateThreadMetadata } from "./threads";
export type {
    AgentComponent,
    Config,
    ContextHandler,
    ContextOptions,
    RawRequestResponseHandler,
    StorageOptions,
    SyncStreamsReturnValue,
    Thread,
    UsageHandler,
} from "./types";
export { stepCountIs } from "ai";

export class Agent<
    /**
     * You can require that all `ctx` args to generateText & streamText
     * have a certain shape by passing a type here.
     * e.g.
     * ```ts
     * const myAgent = new Agent<{ orgId: string }>(...);
     * ```
     * This is useful if you want to share that type in `createTool`
     * e.g.
     * ```ts
     * type MyCtx = ToolCtx & { orgId: string };
     * const myTool = createTool({
     *   args: z.object({...}),
     *   description: "...",
     *   handler: async (ctx: MyCtx, args) => {
     *     // use ctx.orgId
     *   },
     * });
     */
    CustomContext extends object = object,
    AgentTools extends ToolSet = any,
> {
    constructor(
        public component: AgentComponent,
        public options: Config & {
            /**
             * The default system prompt to put in each request.
             * Override per-prompt by passing the "system" parameter.
             */
            instructions?: string;

            /**
             * The LLM model to use for generating / streaming text and objects.
             * Can be a LanguageModel (string for gateway or LanguageModelV2) or ImageModelV3 for image generation.
             * e.g.
             * import { openai } from "@ai-sdk/openai"
             * const myAgent = new Agent(components.agent, {
             *   languageModel: openai.chat("gpt-4o-mini"),
             *   // or for image generation:
             *   languageModel: openai.image("dall-e-3"),
             */
            languageModel: LanguageModel | ImageModelV3;

            /**
             * The name for the agent. This will be attributed on each message
             * created by this agent.
             */
            name: string;

            /**
             * When generating or streaming text with tools available, this
             * determines when to stop. Defaults to the AI SDK default.
             */
            stopWhen?: StopCondition<NoInfer<AgentTools>> | StopCondition<NoInfer<AgentTools>>[];

            /**
             * Tools that the agent can call out to and get responses from.
             * They can be AI SDK tools (import {tool} from "ai")
             * or tools that have backend context
             * (import { createTool } from "./agent/client")
             */
            tools?: AgentTools;
        },
    ) {}

    /**
     * Start a new thread with the agent. This will have a fresh history, though if
     * you pass in a userId you can have it search across other threads for relevant
     * messages as context for the LLM calls.
     * @param ctx The context of the backend function. From an action, you can thread
     * with the agent. From a mutation, you can start a thread and save the threadId
     * to pass to continueThread later.
     * @param args The thread metadata.
     * @returns The threadId of the new thread and the thread object.
     */
    async createThread(
        ctx: ActionContext & CustomContext,
        args?: {
            /**
             * The summary of the thread. Not currently used for anything.
             */
            summary?: string;

            /**
             * The title of the thread. Not currently used for anything.
             */
            title?: string;

            /**
             * The userId to associate with the thread. If not provided, the thread will be
             * anonymous.
             */
            userId?: string | null;
        },
    ): Promise<{ thread: Thread<AgentTools>; threadId: string }>;

    /**
     * Start a new thread with the agent. This will have a fresh history, though if
     * you pass in a userId you can have it search across other threads for relevant
     * messages as context for the LLM calls.
     * @param ctx The context of the backend function. From a mutation, you can
     * start a thread and save the threadId to pass to continueThread later.
     * @param args The thread metadata.
     * @returns The threadId of the new thread.
     */
    async createThread(
        ctx: MutationContext,
        args?: {
            /**
             * The summary of the thread. Not currently used for anything.
             */
            summary?: string;

            /**
             * The title of the thread. Not currently used for anything.
             */
            title?: string;

            /**
             * The userId to associate with the thread. If not provided, the thread will be
             * anonymous.
             */
            userId?: string | null;
        },
    ): Promise<{ threadId: string }>;
    async createThread(
        context: (ActionContext & CustomContext) | MutationContext,
        args?: { summary?: string; title?: string; userId: string | null },
    ): Promise<{ thread?: Thread<AgentTools>; threadId: string }> {
        const threadId = await createThread(context, this.component, args);

        if (!("runAction" in context) || "workflowId" in context) {
            return { threadId };
        }

        const { thread } = await this.continueThread(context, {
            threadId,
            userId: args?.userId,
        });

        return { thread, threadId };
    }

    /**
     * Continues a thread using this agent. Note: threads can be continued
     * by different agents. This is a convenience around calling the various
     * generate and stream functions with explicit userId and threadId parameters.
     * @param ctx The ctx object passed to the action handler
     * @param args the thread and user to associate the messages with.
     * @returns Functions bound to the userId and threadId on a `{thread}` object.
     */
    async continueThread(
        ctx: ActionContext & CustomContext,
        args: {
            /**
             * The associated thread created by {@link createThread}
             */
            threadId: string;

            /**
             * If supplied, the userId can be used to search across other threads for
             * relevant messages from the same user as context for the LLM calls.
             */
            userId?: string | null;
        },
    ): Promise<{ thread: Thread<AgentTools> }> {
        return {
            thread: {
                generateObject: this.generateObject.bind(this, ctx, args),
                generateText: this.generateText.bind(this, ctx, args),
                getMetadata: this.getThreadMetadata.bind(this, ctx, {
                    threadId: args.threadId,
                }),
                streamObject: this.streamObject.bind(this, ctx, args),
                streamText: this.streamText.bind(this, ctx, args),
                threadId: args.threadId,
                updateMetadata: (patch: Partial<Omit<ThreadDoc, "_creationTime" | "_id">>) =>
                    ctx.runMutation(internal.agent.threads.updateThread, {
                        patch,
                        threadId: asId<"threads">(args.threadId),
                    }),
            } as Thread<AgentTools>,
        };
    }

    async start<
        TOOLS extends ToolSet | undefined,
        T extends {
            _internal?: { generateId?: IdGenerator };
        },
    >(
        context: ActionContext & CustomContext,

        /**
         * These are the arguments you'll pass to the LLM call such as
         * `generateText` or `streamText`. This function will look up the context
         * and provide functions to save the steps, abort the generation, and more.
         * The type of the arguments returned infers from the type of the arguments
         * you pass here.
         */
        args: AgentPrompt &
            T & {
                /**
                 * The abort signal to be passed to the LLM call. If triggered, it will
                 * mark the pending message as failed. If the generation is asynchronously
                 * aborted, it will trigger this signal when detected.
                 */
                abortSignal?: AbortSignal;
                stopWhen?: StopCondition<TOOLS extends undefined ? AgentTools : TOOLS> | StopCondition<TOOLS extends undefined ? AgentTools : TOOLS>[];

                /**
                 * The tools to use for the tool calls. This will override tools specified
                 * in the Agent constructor or createThread / continueThread.
                 */
                tools?: TOOLS;
            },
        options?: Options & { threadId?: string; userId?: string | null },
    ): Promise<{
        args: CallSettings &
            T & {
                messages: ModelMessage[];
                model: LanguageModel;
                prompt?: never;
                system?: string;
                tools?: TOOLS extends undefined ? AgentTools : TOOLS;
            };
        fail: (reason: string) => Promise<void>;
        getSavedMessages: () => MessageDoc[];
        order: number;
        promptMessageId: string | undefined;
        save: <InnerTools extends ToolSet>(
            toSave: { step: StepResult<InnerTools> } | { object: GenerateObjectResult<unknown> },
            shouldCreatePendingMessage?: boolean,
        ) => Promise<void>;
        stepOrder: number;
        updateModel: (model: LanguageModel | undefined) => void;
        userId: string | undefined;
    }> {
        type Tools = TOOLS extends undefined ? AgentTools : TOOLS;

        return startGeneration<T, Tools, CustomContext>(
            context,
            this.component,
            {
                ...args,
                stopWhen: (args.stopWhen ?? this.options.stopWhen) as StopCondition<Tools> | StopCondition<Tools>[],
                system: args.system ?? this.options.instructions,
                tools: (args.tools ?? this.options.tools) as Tools,
            },
            {
                ...this.options,
                ...options,
                agentForToolCtx: this,
                agentName: this.options.name,
            },
        );
    }

    /**
     * This behaves like {@link generateText} from the "ai" package except that
     * it add context based on the userId and threadId and saves the input and
     * resulting messages to the thread, if specified.
     * Use {@link continueThread} to get a version of this function already scoped
     * to a thread (and optionally userId).
     * @param ctx The context passed from the action function calling this.
     * @param scope The user and thread to associate the message with
     * @param generateTextArgs The arguments to the generateText function, along
     * with {@link AgentPrompt} options, such as promptMessageId.
     * @param options Extra controls for the {@link ContextOptions} and {@link StorageOptions}.
     * @returns The result of the generateText function.
     */
    async generateText<TOOLS extends ToolSet | undefined = undefined, OUTPUT extends Output<any, any, any> = never>(
        ctx: ActionContext & CustomContext,
        threadOptions: { threadId?: string; userId?: string | null },

        /**
         * The arguments to the generateText function, similar to the ai sdk's
         * {@link generateText} function, along with Agent prompt options.
         */
        generateTextArgs: AgentPrompt & TextArgs<AgentTools, TOOLS, OUTPUT>,
        options?: Options,
    ): Promise<GenerateTextResult<TOOLS extends undefined ? AgentTools : TOOLS, AiContext, OUTPUT> & GenerationOutputMetadata> {
        const { args, order, promptMessageId, ...call } = await this.start(ctx, generateTextArgs, { ...threadOptions, ...options });

        type Tools = TOOLS extends undefined ? AgentTools : TOOLS;
        const steps: StepResult<Tools>[] = [];

        try {
            const result = (await generateText<Tools, AiContext, OUTPUT>({
                ...args,
                onStepFinish: async (step) => {
                    steps.push(step);
                    await call.save({ step }, await willContinue(steps, args.stopWhen));

                    return generateTextArgs.onStepFinish?.(step);
                },
                prepareStep: async (callOptions) => {
                    const stepResult = await generateTextArgs.prepareStep?.(callOptions);

                    call.updateModel(stepResult?.model ?? callOptions.model);

                    return stepResult;
                },
            })) as GenerateTextResult<Tools, AiContext, OUTPUT>;
            const metadata: GenerationOutputMetadata = {
                order,
                promptMessageId,
                savedMessages: call.getSavedMessages(),
            };

            return Object.assign(result, metadata);
        } catch (error) {
            const errorMessage = getErrorMessage(error);

            // Auto-retry on context exceeded: compress messages and retry once
            if (isContextExceededError(errorMessage) && !(generateTextArgs as ContextRetryMarker)._contextRetried) {
                console.warn("[generateText] Context exceeded, retrying with compressed messages");
                await call.fail("Context exceeded — retrying with compression");

                const modelId = getModelName(args.model);
                const contextWindow = getModelContextWindow(modelId);
                const compressed = compressContextMessages(args.messages, contextWindow);

                const retryArgs: AgentPrompt & ContextRetryMarker & TextArgs<AgentTools, TOOLS, OUTPUT> = {
                    ...generateTextArgs,
                    _contextRetried: true,
                    messages: compressed,
                    prompt: undefined,
                    promptMessageId: undefined,
                };

                return this.generateText(ctx, threadOptions, retryArgs, options);
            }

            await call.fail(errorMessage);
            throw error;
        }
    }

    /**
     * This behaves like {@link streamText} from the "ai" package except that
     * it add context based on the userId and threadId and saves the input and
     * resulting messages to the thread, if specified.
     * Use {@link continueThread} to get a version of this function already scoped
     * to a thread (and optionally userId).
     */
    async streamText<TOOLS extends ToolSet | undefined = undefined, OUTPUT extends Output<any, any, any> = never>(
        context: ActionContext & CustomContext,
        threadOptions: { threadId?: string; userId?: string | null },

        /**
         * The arguments to the streamText function, similar to the ai sdk's
         * {@link streamText} function, along with Agent prompt options.
         */
        streamTextArgs: AgentPrompt & StreamingTextArgs<AgentTools, TOOLS, OUTPUT>,

        /**
         * The {@link ContextOptions} and {@link StorageOptions}
         * options to use for fetching contextual messages and saving input/output messages.
         */
        options?: Options & {
            /**
             * Whether to save incremental data (deltas) from streaming responses.
             * Defaults to false.
             * If false, it will not save any deltas to the database.
             * If true, it will save deltas with {@link DEFAULT_STREAMING_OPTIONS}.
             *
             * Regardless of this option, when streaming you are able to use this
             * `streamText` function as you would with the "ai" package's version:
             * iterating over the text, streaming it over HTTP, etc.
             */
            saveStreamDeltas?: boolean | StreamingOptions;
        },
    ): Promise<GenerationOutputMetadata & StreamTextResult<TOOLS extends undefined ? AgentTools : TOOLS, AiContext, OUTPUT>> {
        type Tools = TOOLS extends undefined ? AgentTools : TOOLS;

        return streamText<Tools, OUTPUT>(
            context,
            this.component,
            {
                ...streamTextArgs,
                // Cast to LanguageModel since streamText only works with text models (not ImageModelV3)
                model: (streamTextArgs.model ?? this.options.languageModel) as LanguageModel | undefined,
                stopWhen: (streamTextArgs.stopWhen ?? this.options.stopWhen) as never,
                system: streamTextArgs.system ?? this.options.instructions,
                tools: (streamTextArgs.tools ?? this.options.tools) as Tools,
            },
            {
                ...threadOptions,
                ...this.options,
                agentForToolCtx: this,
                agentName: this.options.name,
                ...options,
            },
        );
    }

    /**
     * This behaves like generateObject from the "ai" package except that
     * it add context based on the userId and threadId and saves the input and
     * resulting messages to the thread, if specified.
     * Use {@link continueThread} to get a version of this function already scoped
     * to a thread (and optionally userId).
     *
     * Note: Internally uses AI SDK v6 Output API (generateText with Output.object/array/choice).
     */
    async generateObject<
        SCHEMA extends FlexibleSchema<unknown> = FlexibleSchema<JSONValue>,
        OUTPUT extends ObjectMode = InferSchema<SCHEMA> extends string ? "enum" : "object",
        RESULT = OUTPUT extends "array" ? InferSchema<SCHEMA>[] : InferSchema<SCHEMA>,
    >(
        context: ActionContext & CustomContext,
        threadOptions: { threadId?: string; userId?: string | null },

        /**
         * The arguments to the generateObject function, similar to the ai sdk's
         * generateObject function, along with Agent prompt options.
         */
        generateObjectArgs: AgentPrompt & GenerateObjectArgs<SCHEMA, OUTPUT, RESULT>,

        /**
         * The {@link ContextOptions} and {@link StorageOptions}
         * options to use for fetching contextual messages and saving input/output messages.
         */
        options?: Options,
    ): Promise<GenerateObjectResult<RESULT> & GenerationOutputMetadata> {
        return generateObjectFor<CustomContext, AgentTools, SCHEMA, OUTPUT, RESULT>(this, context, threadOptions, generateObjectArgs, options);
    }

    /**
     * This behaves like streamObject from the "ai" package except that
     * it add context based on the userId and threadId and saves the input and
     * resulting messages to the thread, if specified.
     * Use {@link continueThread} to get a version of this function already scoped
     * to a thread (and optionally userId).
     *
     * Note: Internally uses AI SDK v6 Output API (streamText with Output.object/array/choice).
     */
    async streamObject<
        SCHEMA extends FlexibleSchema<unknown> = FlexibleSchema<JSONValue>,
        OUTPUT extends ObjectMode = InferSchema<SCHEMA> extends string ? "enum" : "object",
        RESULT = OUTPUT extends "array" ? InferSchema<SCHEMA>[] : InferSchema<SCHEMA>,
    >(
        context: ActionContext & CustomContext,
        threadOptions: { threadId?: string; userId?: string | null },

        /**
         * The arguments to the streamObject function, similar to the ai sdk's
         * streamObject function, along with Agent prompt options.
         */
        streamObjectArgs: AgentPrompt & StreamObjectArgs<SCHEMA, OUTPUT, RESULT>,

        /**
         * The {@link ContextOptions} and {@link StorageOptions}
         * options to use for fetching contextual messages and saving input/output messages.
         */
        options?: Options,
    ): Promise<GenerationOutputMetadata & StreamObjectCompatResult<RESULT>> {
        return streamObjectFor<CustomContext, AgentTools, SCHEMA, OUTPUT, RESULT>(this, context, threadOptions, streamObjectArgs, options);
    }

    /**
     * Save a message to the thread.
     * @param ctx A ctx object from a mutation or action.
     * @param args The message and what to associate it with (user / thread)
     * You can pass extra metadata alongside the message, e.g. associated fileIds.
     * @returns The messageId of the saved message.
     */
    async saveMessage(
        ctx: WritableAgentContext,
        args: SaveMessageArgs & {
            /**
             * If true, it will not generate embeddings for the message.
             * Useful if you're saving messages in a mutation where you can't run `fetch`.
             * You can generate them asynchronously by using the scheduler to run an
             * action later that calls `agent.generateAndSaveEmbeddings`.
             */
            skipEmbeddings?: boolean;
        },
    ) {
        const { messages } = await this.saveMessages(ctx, {
            embeddings: args.embedding ? { model: args.embedding.model, vectors: [args.embedding.vector] } : undefined,
            messages: args.prompt === undefined ? [args.message] : [{ content: args.prompt, role: "user" }],
            metadata: args.metadata ? [args.metadata] : undefined,
            pendingMessageId: args.pendingMessageId,
            promptMessageId: args.promptMessageId,
            skipEmbeddings: args.skipEmbeddings,
            threadId: args.threadId,
            userId: args.userId,
        });
        const message = messages.at(-1)!;

        return { message, messageId: message._id };
    }

    /**
     * Explicitly save messages associated with the thread (& user if provided)
     * If you have an embedding model set, it will also generate embeddings for
     * the messages.
     * @param ctx The ctx parameter to a mutation or action.
     * @param args The messages and context to save
     * @returns
     */
    async saveMessages(
        ctx: WritableAgentContext,
        args: SaveMessagesArgs & {
            /**
             * Skip generating embeddings for the messages. Useful if you're
             * saving messages in a mutation where you can't run `fetch`.
             * You can generate them asynchronously by using the scheduler to run an
             * action later that calls `agent.generateAndSaveEmbeddings`.
             */
            skipEmbeddings?: boolean;
        },
    ): Promise<{ messages: MessageDoc[] }> {
        return saveMessagesFor(this, ctx, args);
    }

    /**
     * List messages from a thread.
     * @param ctx A ctx object from a query, mutation, or action.
     * @param args.threadId The thread to list messages from.
     * @param args.paginationOpts Pagination options (e.g. via usePaginatedQuery).
     * @param args.excludeToolMessages Whether to exclude tool messages.
     * False by default.
     * @param args.statuses What statuses to include. All by default.
     * @returns The MessageDoc's in a format compatible with usePaginatedQuery.
     */
    async listMessages(
        ctx: ReadableAgentContext,
        args: {
            excludeToolMessages?: boolean;
            paginationOpts: PaginationOptions;
            statuses?: MessageStatus[];
            threadId: string;
            unlockProof?: string;
        },
    ): Promise<PaginationResult<MessageDoc>> {
        return listMessages(ctx, this.component, args);
    }

    /**
     * A function that handles fetching stream deltas, used with the React hooks
     * `useThreadMessages` or `useStreamingThreadMessages`.
     * @param ctx A ctx object from a query, mutation, or action.
     * @param args.threadId The thread to sync streams for.
     * @param args.streamArgs The stream arguments with per-stream cursors.
     * @returns The deltas for each stream from their existing cursor.
     */
    async syncStreams(
        ctx: ReadableAgentContext,
        args: {
            // By default, only streaming messages are included.
            includeStatuses?: ("streaming" | "finished" | "aborted")[];
            streamArgs: StreamArgs | undefined;
            threadId: string;
        },
    ): Promise<SyncStreamsReturnValue | undefined> {
        return syncStreams(ctx, this.component, args);
    }

    /**
     * Fetch the context messages for a thread.
     * @param ctx Either a query, mutation, or action ctx.
     * If it is not an action context, you can't do text or
     * vector search.
     * @param args The associated thread, user, message
     * @returns
     */
    async fetchContextMessages(
        ctx: ReadableAgentContext,
        args: {
            contextOptions: ContextOptions | undefined;

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
    ): Promise<MessageDoc[]> {
        assert(args.userId || args.threadId, "Specify userId or threadId");
        const contextOptions = {
            ...this.options.contextOptions,
            ...args.contextOptions,
        };

        return fetchContextMessages(ctx, this.component, {
            ...args,
            contextOptions,
            getEmbedding: async (text) => {
                assert("runAction" in ctx);
                assert(this.options.embeddingModel, "An embeddingModel is required to be set on the Agent that you're doing vector search with");
                const result = await embedMany(ctx, {
                    ...this.options,
                    agentName: this.options.name,
                    threadId: args.threadId,
                    userId: args.userId,
                    values: [text],
                });
                const embedding = result.embeddings[0];

                assert(embedding, "Failed to generate embedding for text");

                return {
                    embedding,
                    embeddingModel: this.options.embeddingModel,
                };
            },
        });
    }

    /**
     * Get the metadata for a thread.
     * @param ctx A ctx object from a query, mutation, or action.
     * @param args.threadId The thread to get the metadata for.
     * @returns The metadata for the thread.
     */
    async getThreadMetadata(ctx: ReadableAgentContext, args: { threadId: string }): Promise<ThreadDoc> {
        return getThreadMetadata(ctx, this.component, args);
    }

    /**
     * Update the metadata for a thread.
     * @param ctx A ctx object from a mutation or action.
     * @param args.threadId The thread to update the metadata for.
     * @param args.patch The patch to apply to the thread.
     * @returns The updated thread metadata.
     */
    async updateThreadMetadata(ctx: WritableAgentContext, args: ArgsOf<typeof internal.agent.threads.updateThread>): Promise<ThreadDoc> {
        const thread = await ctx.runMutation(internal.agent.threads.updateThread, args);

        return thread;
    }

    /**
     * Get the embeddings for a set of messages.
     */
    async generateEmbeddings(
        ctx: ActionContext | RunnerCtx,
        args: { threadId: string | undefined; userId: string | undefined },
        messages: (ModelMessage | Message)[],
    ): Promise<
        | {
              dimension: VectorDimension;
              model: string;
              vectors: (number[] | null)[];
          }
        | undefined
    > {
        return embedMessages(ctx, { ...args, ...this.options, agentName: this.options.name }, messages);
    }

    /**
     * Generate embeddings for a set of messages, and save them to the database.
     * It will not generate or save embeddings for messages that already have an
     * embedding.
     * @param ctx The ctx parameter to an action.
     * @param args The messageIds to generate embeddings for.
     */
    async generateAndSaveEmbeddings(ctx: ActionContext, args: { messageIds: string[] }) {
        return generateAndSaveEmbeddingsFor(this, ctx, args);
    }

    /**
     * Explicitly save a "step" created by the AI SDK.
     * @param ctx The ctx argument to a mutation or action.
     * @param args The Step generated by the AI SDK.
     */
    async saveStep<TOOLS extends ToolSet>(
        ctx: ActionContext,
        args: {
            /**
             * The model used to generate the step.
             * Defaults to the chat model for the Agent.
             */
            model?: string;

            /**
             * The message this step is in response to.
             */
            promptMessageId: string;

            /**
             * The provider of the model used to generate the step.
             * Defaults to the chat provider for the Agent.
             */
            provider?: string;

            /**
             * The step to save, possibly including multiple tool calls.
             */
            step: StepResult<TOOLS>;
            threadId: string;
            userId?: string;
        },
    ): Promise<{ messages: MessageDoc[] }> {
        return saveStepFor(this, ctx, args);
    }

    /**
     * Manually save the result of a generateObject call to the thread.
     * This happens automatically when using {@link generateObject} or {@link streamObject}
     * from the `thread` object created by {@link continueThread} or {@link createThread}.
     * @param ctx The context passed from the mutation or action function calling this.
     * @param args The arguments to the saveObject function.
     */
    async saveObject(
        ctx: ActionContext,
        args: {
            metadata?: Omit<MessageWithMetadata, "message">;
            model: string | undefined;
            promptMessageId: string;
            provider: string | undefined;
            result: GenerateObjectResult<unknown>;
            threadId: string;
            userId: string | undefined;
        },
    ): Promise<{ messages: MessageDoc[] }> {
        return saveObjectFor(this, ctx, args);
    }

    /**
     * Commit or rollback a message that was pending.
     * This is done automatically when saving messages by default.
     * If creating pending messages, you can call this when the full "transaction" is done.
     * @param ctx The ctx argument to your mutation or action.
     * @param args What message to save. Generally the parent message sent into
     * the generateText call.
     */
    async finalizeMessage(
        ctx: WritableAgentContext,
        args: {
            messageId: string;
            result: { error: string; status: "failed" } | { status: "success" };
        },
    ): Promise<void> {
        await ctx.runMutation(internal.agent.messages.finalizeMessage, {
            messageId: asId<"messages">(args.messageId),
            result: args.result,
        });
    }

    /**
     * Update a message by its id.
     * @param ctx The ctx argument to your mutation or action.
     * @param args The message fields to update.
     */
    async updateMessage(
        ctx: WritableAgentContext,
        args: {
            /** The id of the message to update. */
            messageId: string;
            patch: {
                /** The error message to set on the message. */
                error?: string;

                /**
                 * These will override the fileIds in the message.
                 * To remove all existing files, pass an empty array.
                 * If passing in a new message, pass in the fileIds you explicitly want to keep
                 * from the previous message, as the new files generated from the new message
                 * will be added to the list.
                 * If you pass undefined, it will not change the fileIds unless new
                 * files are generated from the message. In that case, the new fileIds
                 * will replace the old fileIds.
                 */
                fileIds?: string[];
                /** The message to replace the existing message. */
                message: ModelMessage | Message;
                /** The status to set on the message. */
                status: "success" | "error";
            };
        },
    ): Promise<void> {
        return updateMessageFor(ctx, args);
    }

    /**
     * Delete multiple messages by their ids, including their embeddings
     * and reduce the refcount of any files they reference.
     * @param ctx The ctx argument to your mutation or action.
     * @param args The ids of the messages to delete.
     */
    async deleteMessages(ctx: WritableAgentContext, args: { messageIds: string[] }): Promise<void> {
        await ctx.runMutation(internal.agent.messages.deleteByIds, {
            messageIds: asIdArray<"messages">(args.messageIds),
        });
    }

    /**
     * Delete a single message by its id, including its embedding
     * and reduce the refcount of any files it references.
     * @param ctx The ctx argument to your mutation or action.
     * @param args The id of the message to delete.
     */
    async deleteMessage(ctx: WritableAgentContext, args: { messageId: string }): Promise<void> {
        await ctx.runMutation(internal.agent.messages.deleteByIds, {
            messageIds: [asId<"messages">(args.messageId)],
        });
    }

    /**
     * Delete a range of messages by their order and step order.
     * Each "order" is a set of associated messages in response to the message
     * at stepOrder 0.
     * The (startOrder, startStepOrder) is inclusive
     * and the (endOrder, endStepOrder) is exclusive.
     * To delete all messages at "order" 1, you can pass:
     * `{ startOrder: 1, endOrder: 2 }`
     * To delete a message at step (order=1, stepOrder=1), you can pass:
     * `{ startOrder: 1, startStepOrder: 1, endOrder: 1, endStepOrder: 2 }`
     * To delete all messages between (1, 1) up to and including (3, 5), you can pass:
     * `{ startOrder: 1, startStepOrder: 1, endOrder: 3, endStepOrder: 6 }`
     *
     * If it cannot do it in one transaction, it returns information you can use
     * to resume the deletion.
     * e.g.
     * ```ts
     * let isDone = false;
     * let lastOrder = args.startOrder;
     * let lastStepOrder = args.startStepOrder ?? 0;
     * while (!isDone) {
     *   // eslint-disable-next-line @typescript-eslint/no-explicit-any
     *   ({ isDone, lastOrder, lastStepOrder } = await agent.deleteMessageRange(
     *     ctx,
     *     {
     *       threadId: args.threadId,
     *       startOrder: lastOrder,
     *       startStepOrder: lastStepOrder,
     *       endOrder: args.endOrder,
     *       endStepOrder: args.endStepOrder,
     *     }
     *   ));
     * }
     * ```
     * @param ctx The ctx argument to your mutation or action.
     * @param args The range of messages to delete.
     */
    async deleteMessageRange(
        ctx: WritableAgentContext,
        args: {
            endOrder: number;
            endStepOrder?: number;
            startOrder: number;
            startStepOrder?: number;
            threadId: string;
        },
    ): Promise<{ isDone: boolean; lastOrder?: number; lastStepOrder?: number }> {
        return ctx.runMutation(internal.agent.messages.deleteByOrder, {
            endOrder: args.endOrder,
            endStepOrder: args.endStepOrder,
            startOrder: args.startOrder,
            startStepOrder: args.startStepOrder,
            threadId: asId<"threads">(args.threadId),
        });
    }

    /**
     * Delete a thread and all its messages and streams asynchronously (in batches)
     * This uses a mutation to that processes one page and recursively queues the
     * next page for deletion.
     * @param ctx The ctx argument to your mutation or action.
     * @param args The id of the thread to delete and optionally the page size to use for the delete.
     */
    async deleteThreadAsync(ctx: WritableAgentContext, args: { pageSize?: number; threadId: string }): Promise<void> {
        await ctx.runMutation(internal.agent.threads.deleteAllForThreadIdAsync, {
            limit: args.pageSize,
            threadId: asId<"threads">(args.threadId),
        });
    }

    /**
     * Delete a thread and all its messages and streams synchronously.
     * This uses an action to iterate through all pages. If the action fails
     * partway, it will not automatically restart.
     * @param ctx The ctx argument to your action.
     * @param args The id of the thread to delete and optionally the page size to use for the delete.
     */
    async deleteThreadSync(ctx: ActionContext, args: { pageSize?: number; threadId: string }): Promise<void> {
        await ctx.runAction(internal.agent.threads.deleteAllForThreadIdSync, {
            limit: args.pageSize,
            threadId: asId<"threads">(args.threadId),
        });
    }

    /**
     * WORKFLOW UTILITIES
     */

    /**
     * Create a mutation that creates a thread so you can call it from a Workflow.
     * e.g.
     * ```ts
     * // in lunora/foo.ts
     * export const createThread = weatherAgent.createThreadMutation();
     *
     * const workflow = new WorkflowManager(components.workflow);
     * export const myWorkflow = workflow.define({
     *   args: {},
     *   handler: async (step) => {
     *     const { threadId } = await step.runMutation(internal.foo.createThread);
     *     // use the threadId to generate text, object, etc.
     *   },
     * });
     * ```
     * @returns A mutation that creates a thread.
     */
    createThreadMutation() {
        return internalMutationGeneric
            .input({
                summary: v.optional(v.string()),
                title: v.optional(v.string()),
                userId: v.optional(v.string()),
            })
            .mutation(async ({ args, ctx }): Promise<{ threadId: string }> => {
                const { threadId } = await this.createThread(ctx, args);

                return { threadId };
            });
    }

    /**
     * Create an action out of this agent so you can call it from workflows or other actions
     * without a wrapping function.
     * @param spec Configuration for the agent acting as an action, including
     * {@link ContextOptions}, {@link StorageOptions}, and {@link stopWhen}.
     */
    asTextAction(
        spec: MaybeCustomContext<CustomContext, AgentTools> &
            Options & {
                /**
                 * When to stop generating text.
                 * Defaults to the {@link Agent["options"].stopWhen} option.
                 */
                stopWhen?: StopCondition<AgentTools> | StopCondition<AgentTools>[];

                /**
                 * Whether to stream the text.
                 * If false, it will generate the text in a single call. (default)
                 * If true or {@link StreamingOptions}, it will stream the text from the LLM
                 * and save the chunks to the database with the options you specify, or the
                 * defaults if you pass true.
                 */
                stream?: boolean | StreamingOptions;
            },
        overrides?: CallSettings,
    ): any {
        return internalActionGeneric.input(vTextArgsFields).action(async ({ args, ctx: context_ }) => {
            const stream = args.stream === true ? spec?.stream || true : (spec?.stream ?? false);
            // `callSettings` is destructured out and SPREAD. It used to stay in
            // `rest` and reach `streamText` as a nested `callSettings` object,
            // which `streamText` has no such argument for — so temperature,
            // maxOutputTokens, topP, seed, stopSequences, maxRetries and headers
            // were accepted by the action's validator and then silently dropped.
            // `asObjectAction` below always spread it; only this path did not.
            const { callSettings, maxSteps, messages, prompt, threadId, userId, ...rest } = args;
            const targetArgs = { threadId, userId };
            const llmArgs = {
                stopWhen: spec?.stopWhen,
                ...overrides,
                ...callSettings,
                ...omit(rest, ["storageOptions", "contextOptions", "stream"]),
                messages: messages?.map((item) => toModelMessage(item)),
                prompt: Array.isArray(prompt) ? prompt.map((item) => toModelMessage(item)) : prompt,
                // Storage/SDK boundary: stored metadata has `unknown` leaves,
                // the SDK's `ProviderOptions` wants `JSONValue`.
                providerOptions: rest.providerOptions as SharedV4ProviderOptions | undefined,
                toolChoice: args.toolChoice as ToolChoice<AgentTools>,
                // Deliberately UNTYPED — no `satisfies StreamingTextArgs<AgentTools>`.
                //
                // That type is `Omit<Parameters<typeof streamText<AgentTools, …>>[0], …>`,
                // and ai@7 made streamText's options depend on the tools' RUNTIME
                // CONTEXT: every property now resolves through
                // `IsEmptyObject<Normalize<RequiredToolSetContext<TOOLS> &
                // OptionalToolSetContext<TOOLS>>> extends true ? … : …`. Inside this
                // factory `AgentTools` is an unbound type parameter, so none of those
                // conditionals reduce and nothing is assignable to the result — the
                // check reported the whole object rather than any one field, and
                // asserting past it only moved the same failure to the call sites.
                //
                // The shape is checked where it is consumed: `streamText` /
                // `generateText` are called below with concrete tools.
            };

            if (maxSteps) {
                llmArgs.stopWhen = stepCountIs(maxSteps);
            }

            const options = {
                ...pick(spec, ["contextOptions", "storageOptions"]),
                ...pick(args, ["contextOptions", "storageOptions"]),
                saveStreamDeltas: stream,
            };
            // `as unknown as`, because `CustomCtx` is an unbound type parameter:
            // `ActionCtx` satisfies its `object` constraint but TS cannot rule out
            // that a caller instantiates it with a narrower subtype. Same reason
            // `llmArgs` is asserted to `TextArgs` — see `asObjectAction` below.
            const context = (spec?.customCtx
                ? { ...context_, ...spec.customCtx(context_, targetArgs, llmArgs as unknown as TextArgs<AgentTools>) }
                : context_) as unknown as ActionContext & CustomContext;

            if (stream) {
                const result = await this.streamText<any>(context, targetArgs, llmArgs, options);

                await result.consumeStream();

                return {
                    finishReason: await result.finishReason,
                    order: result.order,
                    promptMessageId: result.promptMessageId,
                    savedMessageIds: result.savedMessages?.map((m) => m._id) ?? [],
                    text: await result.text,
                    warnings: await result.warnings,
                };
            }

            const response = await this.generateText<any>(context, targetArgs, llmArgs, options);

            return {
                finishReason: response.finishReason,
                order: response.order,
                promptMessageId: response.promptMessageId,
                savedMessageIds: response.savedMessages?.map((m) => m._id) ?? [],
                text: response.text,
                warnings: response.warnings,
            };
        });
    }

    /**
     * Create an action that generates an object out of this agent so you can call
     * it from workflows or other actions without a wrapping function.
     * the normal parameters to {@link generateObject}, plus {@link ContextOptions}
     * and stopWhen.
     */
    asObjectAction<T>(
        objectArgs: GenerateObjectArgs<FlexibleSchema<T>> & Partial<AgentPrompt>,
        options?: MaybeCustomContext<CustomContext, AgentTools> & Options,
    ): any {
        return internalActionGeneric.input(vSafeObjectArgsFields).action(async ({ args, ctx: context_ }) => {
            const { callSettings, threadId, userId, ...rest } = args;
            const overrides = pick(rest, ["contextOptions", "storageOptions"]);
            const targetArgs = { threadId, userId };
            const llmArgs = {
                ...objectArgs,
                ...callSettings,
                ...omit(rest, ["storageOptions", "contextOptions"]),
                messages: args.messages?.map((item) => toModelMessage(item)),
                prompt: Array.isArray(args.prompt) ? args.prompt.map((item) => toModelMessage(item)) : args.prompt,
            } as GenerateObjectArgs<FlexibleSchema<T>>;
            // Cast llmArgs to TextArgs since customCtx expects TextArgs but works with either
            const context = (options?.customCtx
                ? { ...context_, ...options.customCtx(context_, targetArgs, llmArgs as unknown as TextArgs<AgentTools>) }
                : context_) as unknown as ActionContext & CustomContext;
            const value = await this.generateObject(context, targetArgs, llmArgs, {
                ...this.options,
                ...options,
                ...overrides,
            });

            return {
                finishReason: value.finishReason,
                object: value.object as T,
                order: value.order,
                promptMessageId: value.promptMessageId,
                savedMessageIds: value.savedMessages?.map((m) => m._id) ?? [],
                warnings: value.warnings,
            };
        });
    }

    /**
     * Approve a pending tool call and continue generation.
     *
     * This is a helper for the AI SDK v6 tool approval workflow. When a tool
     * with `needsApproval: true` is called, it returns a `tool-approval-request`.
     * Call this method to approve the tool, execute it, and continue generation.
     * @param ctx The action context, optionally extended with custom context.
     * @param threadOptions.userId Optional user ID to associate with the tool execution.
     * @param threadOptions.threadId The thread containing the pending tool call.
     * @param approvalArgs Approval response details.
     * @param approvalArgs.approvalId The approval ID from the `tool-approval-request` content part.
     * @param approvalArgs.reason Optional reason for approving the tool call.
     * @param streamTextArgs Arguments for continuing text generation after tool execution.
     * Similar to the AI SDK's `streamText` function, along with Agent prompt options.
     * Note: `promptMessageId` and `forceNewOrder` will be overridden internally.
     * Defaults to `{ chunking: "word", throttleMs: 100 }`.
     */
    async approveToolCall(
        ctx: ActionContext & CustomContext,
        {
            threadId,
            userId,
        }: {
            threadId: string;
            userId?: string | null;
        },
        approvalArgs: {
            approvalId: string;
            reason?: string;
        },

        /**
         * The arguments to the streamText function, similar to the ai sdk's
         * {@link streamText} function, along with Agent prompt options.
         *
         * `promptMessageId` & `forceNewOrder` will be overridden by the approval tool call
         */
        streamTextArgs?: AgentPrompt & StreamingTextArgs<AgentTools>,

        /**
         * The {@link ContextOptions} and {@link StorageOptions}
         * options to use for fetching contextual messages and saving input/output messages.
         */
        options?: Options & {
            /**
             * Whether to save incremental data (deltas) from streaming responses.
             * Defaults to `{ chunking: "word", throttleMs: 100 }`.
             * If false, it will not save any deltas to the database.
             * If true, it will save deltas with {@link DEFAULT_STREAMING_OPTIONS}.
             */
            saveStreamDeltas?: boolean | StreamingOptions;
        },
    ): Promise<GenerationOutputMetadata & StreamTextResult<AgentTools, AiContext, never>> {
        return approveToolCallFor(this, ctx, { threadId, userId }, approvalArgs, streamTextArgs, options);
    }

    /**
     * Deny a pending tool call and continue generation.
     *
     * This is a helper for the AI SDK v6 tool approval workflow. When a tool
     * with `needsApproval: true` is called, it returns a `tool-approval-request`.
     * Call this method to deny the tool and let the LLM respond to the denial.
     * @param ctx The context from an action.
     * @param args The approval to deny.
     * @param args.threadId The thread containing the tool call.
     * @param args.approvalId The approval ID from the tool-approval-request.
     * @param args.reason Optional reason for the denial.
     * @param streamTextArgs Continuation arguments, as for `approveToolCall` —
     * pass the same ones so a denied call continues with the same reasoning
     * options and step preparation as an approved one.
     * @param options Context/storage options, as for `approveToolCall`.
     * @returns The result of the continued generation.
     */
    async denyToolCall(
        ctx: ActionContext & CustomContext,
        args: {
            approvalId: string;
            reason?: string;
            threadId: string;
        },
        streamTextArgs?: AgentPrompt & StreamingTextArgs<AgentTools>,
        options?: Options & { saveStreamDeltas?: boolean | StreamingOptions },
    ): Promise<GenerationOutputMetadata & StreamTextResult<ToolSet, AiContext, never>> {
        return denyToolCallFor(this, ctx, args, streamTextArgs, options);
    }
}
