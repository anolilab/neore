import type { ImageModelV3, JSONValue } from "@ai-sdk/provider";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { Context as AiContext } from "@ai-sdk/provider-utils";
import { type FlexibleSchema, getErrorMessage, type IdGenerator, type InferSchema, type ToolContent } from "@ai-sdk/provider-utils";
import type {
    CallSettings,
    CallWarning,
    GenerateObjectResult,
    GenerateTextResult,
    LanguageModel,
    LanguageModelRequestMetadata,
    LanguageModelUsage,
    ModelMessage,
    StaticToolError,
    StaticToolResult,
    StepResult,
    StopCondition,
    StreamTextResult,
    Tool,
    ToolChoice,
    ToolSet,
} from "ai";
import { generateText, Output as AIOutput, stepCountIs, streamText as streamTextAI } from "ai";
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
import { serializeMessage, serializeNewMessagesInStep, serializeObjectResult, toModelMessage } from "../mapping";
import { createToolModelOutput, getModelName, getProviderName } from "../shared";
import {
    type Message,
    type MessageDoc,
    type MessageStatus,
    type MessageWithMetadata,
    type MessageWithMetadataInternal,
    type StreamArgs,
    type ThreadDoc,
    vSafeObjectArgsFields,
    vTextArgsFields,
} from "../validators";
import type { VectorDimension } from "../vector/tables";
import { listMessages, type SaveMessageArgs, saveMessages, type SaveMessagesArgs } from "./messages";
import { embedMany, embedMessages, fetchContextMessages, generateAndSaveEmbeddings } from "./search";
import startGeneration from "./start";
import streamText from "./stream-text";
import { type StreamingOptions, syncStreams } from "./streaming";
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
    QueryCtx as QueryContext,
    RunnerCtx,
    StreamingTextArgs,
    StreamObjectArgs,
    SyncStreamsReturnValue,
    TextArgs,
    Thread,
} from "./types";
import { asId, asIdArray, asOptionalIdArray, willContinue } from "./utilities";

/** Any context that can read: a query, a mutation or an action. */
type ReadableAgentContext = QueryContext | MutationContext | ActionContext;

/** Any context that can write: a mutation, an action, or a runner. */
type WritableAgentContext = MutationContext | ActionContext | RunnerCtx;

export { deriveUIMessagesFromDeltas } from "../deltas";

/**
 * Compatibility type for streamObject return value.
 * Maps the new AI SDK v6 Output API (streamText with Output) to the old streamObject interface.
 */
interface StreamObjectCompatResult<RESULT> {
    /** Promise that resolves to the final complete object */
    readonly object: Promise<RESULT>;
    /** Stream of partial objects as they are being generated */
    readonly partialObjectStream: AsyncIterable<Partial<RESULT>>;
    /** Request metadata */
    readonly request: Promise<LanguageModelRequestMetadata>;
    /** Convert the stream to a Response for HTTP streaming */
    toTextStreamResponse: () => Response;
    /** Token usage information */
    readonly usage: Promise<LanguageModelUsage>;
    /** Warnings from the model provider */
    readonly warnings: Promise<CallWarning[] | undefined>;
}

/**
 * Sentinel stamped onto the args of a context-compression retry so the retry
 * cannot recurse. It is deliberately not part of `TextArgs` — it never reaches
 * the model — so it needs its own carrier type rather than widening the
 * public argument type.
 */
type ContextRetryMarker = { _contextRetried?: boolean };

/**
 * Marker that `createTool` stamps on tools wanting our `ToolCtx` injected.
 * ai@7's `Tool` has no slot for it, so reading it needs this narrowing.
 * @see ./createTool.ts
 */
type ContextAcceptingTool = { __acceptsCtx?: boolean };
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
        const { args, fail, getSavedMessages, order, promptMessageId, save } = await this.start(context, generateObjectArgs, { ...threadOptions, ...options });

        try {
            // Extract schema/enum from args and determine the Output type
            const {
                enum: enumValues,
                mode,
                schema,
                ...restArgs
            } = args as typeof args & {
                enum?: RESULT[];
                mode?: OUTPUT;
                schema?: SCHEMA;
            };

            // Build the output specification based on the mode/args
            let output;

            if (enumValues && enumValues.length > 0) {
                // Enum mode: use AIOutput.choice
                output = AIOutput.choice({ options: enumValues as string[] });
            } else if (mode === "array" && schema) {
                // Array mode: use AIOutput.array
                output = AIOutput.array({ element: schema });
            } else if (schema) {
                // Object mode (default): use AIOutput.object
                output = AIOutput.object({ schema });
            } else {
                // No schema: use AIOutput.json for unstructured JSON
                output = AIOutput.json();
            }

            // Call generateText with the Output API
            const textResult = await generateText({
                ...restArgs,
                output,
            });

            // Extract the output - use Output API result if available, otherwise parse text as JSON
            let outputObject: RESULT;

            try {
                // Try to get structured output from the Output API
                outputObject = textResult.output as RESULT;
            } catch {
                // Fallback: parse text response as JSON for models that don't support structured outputs
                if (textResult.text) {
                    try {
                        outputObject = JSON.parse(textResult.text) as RESULT;
                    } catch {
                        throw new Error(`Failed to parse model response as JSON: ${textResult.text}`);
                    }
                } else {
                    throw new Error("No output generated: model returned neither structured output nor parseable text");
                }
            }

            // Map the result to GenerateObjectResult format for backward compatibility
            const result = {
                finishReason: textResult.finishReason,
                object: outputObject,
                providerMetadata: textResult.providerMetadata,
                reasoning: textResult.reasoningText,
                request: textResult.request,
                response: textResult.response,
                toJsonResponse: () => Response.json(textResult.output),
                usage: textResult.usage,
                warnings: textResult.warnings,
            } as GenerateObjectResult<RESULT>;

            await save({ object: result });
            const metadata: GenerationOutputMetadata = {
                order,
                promptMessageId,
                savedMessages: getSavedMessages(),
            };

            return Object.assign(result, metadata);
        } catch (error) {
            await fail(getErrorMessage(error));
            throw error;
        }
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
        const { args, fail, getSavedMessages, order, promptMessageId, save } = await this.start(context, streamObjectArgs, { ...threadOptions, ...options });

        // Extract schema/enum from args and determine the Output type
        const {
            enum: enumValues,
            mode,
            onError,
            onFinish,
            schema,
            ...restArgs
        } = args as typeof args & {
            enum?: RESULT[];
            mode?: OUTPUT;
            onError?: (error: { error: unknown }) => void | Promise<void>;
            onFinish?: (result: any) => void | Promise<void>;
            schema?: SCHEMA;
        };

        // Build the output specification based on the mode/args
        let output;

        if (enumValues && enumValues.length > 0) {
            output = AIOutput.choice({ options: enumValues as string[] });
        } else if (mode === "array" && schema) {
            output = AIOutput.array({ element: schema });
        } else if (schema) {
            output = AIOutput.object({ schema });
        } else {
            output = AIOutput.json();
        }

        // Store references for the onFinish callback
        let streamRef: ReturnType<typeof streamTextAI> | null = null;

        // Call streamText with the Output API
        const stream = streamTextAI({
            ...restArgs,
            onError: async (error) => {
                console.error(" streamObject onError", error);
                await fail(getErrorMessage(error.error));

                return onError?.(error);
            },
            onFinish: async (result) => {
                // Get the output from the stream
                const outputValue = streamRef ? await streamRef.output : undefined;
                const requestValue = streamRef ? await streamRef.request : ({} as LanguageModelRequestMetadata);

                await save({
                    object: {
                        finishReason: result.finishReason,
                        object: outputValue,
                        providerMetadata: result.providerMetadata,
                        reasoning: result.reasoningText,
                        request: requestValue,
                        response: result.response,
                        toJsonResponse: () => streamRef?.toTextStreamResponse() ?? new Response(),
                        usage: result.usage,
                        warnings: result.warnings,
                    },
                });

                // Adapt the result for the onFinish callback
                if (onFinish) {
                    const adaptedResult = {
                        error: undefined,
                        object: outputValue,
                        providerMetadata: result.providerMetadata,
                        response: result.response,
                        usage: result.usage,
                        warnings: result.warnings,
                    };

                    await onFinish(adaptedResult);
                }
            },
            output,
        });

        // Store the stream reference for use in onFinish
        streamRef = stream;

        // Create a compatibility wrapper that exposes partialObjectStream (mapped from partialOutputStream)
        const compatStream: StreamObjectCompatResult<RESULT> = {
            get object() {
                return stream.output as unknown as Promise<RESULT>;
            },
            // Map partialOutputStream to partialObjectStream for backward compatibility
            get partialObjectStream() {
                return stream.partialOutputStream as unknown as AsyncIterable<Partial<RESULT>>;
            },
            get request() {
                return stream.request as unknown as Promise<LanguageModelRequestMetadata>;
            },
            toTextStreamResponse: () => stream.toTextStreamResponse(),
            get usage() {
                return stream.usage as unknown as Promise<LanguageModelUsage>;
            },
            get warnings() {
                return stream.warnings as unknown as Promise<CallWarning[] | undefined>;
            },
        };

        const metadata: GenerationOutputMetadata = {
            order,
            promptMessageId,
            savedMessages: getSavedMessages(),
        };

        return Object.assign(compatStream, metadata);
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
        let embeddings: { model: string; vectors: (number[] | null)[] } | undefined;
        const { skipEmbeddings, ...rest } = args;

        if (args.embeddings) {
            embeddings = args.embeddings;
        } else if (!skipEmbeddings && this.options.embeddingModel) {
            if (!("runAction" in ctx)) {
                console.warn(
                    "You're trying to save messages and generate embeddings, but you're in a mutation. " +
                        "Pass `skipEmbeddings: true` to skip generating embeddings in the mutation and skip this warning. " +
                        "They will be generated lazily when you generate or stream text / objects. " +
                        "You can explicitly generate them asynchronously by using the scheduler to run an action later that calls `agent.generateAndSaveEmbeddings`.",
                );
            } else if ("workflowId" in ctx) {
                console.warn(
                    "You're trying to save messages and generate embeddings, but you're in a workflow. " +
                        "Pass `skipEmbeddings: true` to skip generating embeddings in the workflow and skip this warning. " +
                        "They will be generated lazily when you generate or stream text / objects. " +
                        "You can explicitly generate them asynchronously by using the scheduler to run an action later that calls `agent.generateAndSaveEmbeddings`.",
                );
            } else {
                embeddings = await this.generateEmbeddings(ctx, { threadId: args.threadId, userId: args.userId ?? undefined }, args.messages);
            }
        }

        return saveMessages(ctx, {
            ...rest,
            agentName: this.options.name,
            embeddings,
        });
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
        const fetched = await ctx.runQuery(internal.agent.messages.getMessagesByIds, {
            messageIds: asIdArray<"messages">(args.messageIds),
        });
        const messages = fetched.filter((m): m is NonNullable<typeof m> => m !== null);

        if (messages.length !== args.messageIds.length) {
            throw new Error(`Some messages were not found: ${args.messageIds.filter((id) => messages.every((m) => m?._id !== id)).join(", ")}`);
        }

        if (messages.length === 0) {
            throw new Error("No messages provided to generate embeddings for");
        }

        if (messages.some((m) => !m.message)) {
            throw new Error(
                `Some messages don't have a message: ${messages
                    .filter((m) => !m.message)
                    .map((m) => m._id)
                    .join(", ")}`,
            );
        }

        const { embeddingModel } = this.options;

        if (!embeddingModel) {
            throw new Error("No embeddings were generated for the messages. You must pass an embeddingModel to the agent constructor.");
        }

        const firstMessage = messages[0];

        if (!firstMessage) {
            throw new Error("No messages to generate embeddings for");
        }

        await generateAndSaveEmbeddings(
            ctx,
            this.component,
            {
                ...this.options,
                agentName: this.options.name,
                embeddingModel,
                threadId: firstMessage.threadId,
                userId: firstMessage.userId,
            },
            messages,
        );
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
        const { messages } = await serializeNewMessagesInStep(ctx, args.step, {
            model: args.model ?? getModelName(this.options.languageModel),
            provider: args.provider ?? getProviderName(this.options.languageModel),
        });
        const embeddings = await this.generateEmbeddings(
            ctx,
            { threadId: args.threadId, userId: args.userId },
            messages.map((m) => m.message),
        );

        return ctx.runMutation(internal.agent.messages.addMessages, {
            agentName: this.options.name,
            embeddings,
            failPendingSteps: false,
            // The serializers produce the public `MessageWithMetadata` whose
            // `fileIds` are bare strings; `addMessages` takes the internal shape
            // with branded `Id<"chatFiles">`. Only the brand differs.
            messages: messages as MessageWithMetadataInternal[],
            promptMessageId: asId<"messages">(args.promptMessageId),
            threadId: asId<"threads">(args.threadId),
            userId: args.userId,
        });
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
        const { messages } = await serializeObjectResult(ctx, args.result, {
            model: args.model ?? args.metadata?.model ?? getModelName(this.options.languageModel),
            provider: args.provider ?? args.metadata?.provider ?? getProviderName(this.options.languageModel),
        });
        const embeddings = await this.generateEmbeddings(
            ctx,
            { threadId: args.threadId, userId: args.userId },
            messages.map((m) => m.message),
        );

        return ctx.runMutation(internal.agent.messages.addMessages, {
            agentName: this.options.name,
            embeddings,
            failPendingSteps: false,
            // See `saveStep`: only the `fileIds` brand differs between the
            // public and internal message shapes.
            messages: messages as MessageWithMetadataInternal[],
            promptMessageId: asId<"messages">(args.promptMessageId),
            threadId: asId<"threads">(args.threadId),
            userId: args.userId,
        });
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
        const { fileIds, message } = await serializeMessage(ctx, args.patch.message);

        await ctx.runMutation(internal.agent.messages.updateMessage, {
            messageId: asId<"messages">(args.messageId),
            patch: {
                error: args.patch.error,
                fileIds: asOptionalIdArray<"chatFiles">(args.patch.fileIds ? [...args.patch.fileIds, ...(fileIds ?? [])] : fileIds),
                message,
                status: args.patch.status === "success" ? "success" : "failed",
            },
        });
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
        const { approvalId, reason } = approvalArgs;

        const toolInfo = await this._findToolCallInfo(ctx, threadId, approvalId);

        if (!toolInfo) {
            throw new Error(`Could not find tool call for approval ID: ${approvalId}`);
        }

        if (toolInfo.alreadyHandled) {
            if (toolInfo.wasApproved) {
                throw new Error(`Tool call was already approved for approval ID: ${approvalId}`);
            }

            throw new Error(`Cannot approve tool call that was already denied for approval ID: ${approvalId}`);
        }

        const { parentMessageId, toolCallId, toolInput, toolName } = toolInfo;

        // Race-narrowing re-check: two concurrent approveToolCall invocations
        // with the same approvalId can both pass the initial alreadyHandled
        // gate. Re-check just before tool execution to shrink the window. A
        // strict guarantee would require an atomic claim mutation; this
        // mitigates the common case (slow human review issuing duplicate
        // clicks) without rearchitecting the flow.
        const recheck = await this._findToolCallInfo(ctx, threadId, approvalId);

        if (recheck && recheck.alreadyHandled) {
            if (recheck.wasApproved) {
                throw new Error(`Tool call was already approved for approval ID: ${approvalId}`);
            }

            throw new Error(`Cannot approve tool call that was already denied for approval ID: ${approvalId}`);
        }

        // Execute the tool
        const { tools } = this.options;
        const tool = tools?.[toolName] as Tool<any, StaticToolResult<AgentTools> | StaticToolError<AgentTools>>;

        if (!tool) {
            throw new Error(`Tool not found: ${toolName}`);
        }

        // Get thread metadata to propagate userId to tool context if needed
        let resolvedUserId = userId;

        if (!resolvedUserId) {
            ({ userId: resolvedUserId } = await this.getThreadMetadata(ctx, { threadId }));
        }

        const toolResult: ToolContent = [
            {
                approvalId,
                approved: true,
                reason,
                type: "tool-approval-response" as const,
            },
        ];

        try {
            // Execute with context injection (like wrapTools does)
            const toolContext = {
                ...ctx,
                agent: this,
                threadId,
                userId: resolvedUserId,
            };
            const wrappedTool = (tool as ContextAcceptingTool).__acceptsCtx ? { ...tool, ctx: toolContext } : tool;
            // `context: {}` is new. ai@7's `ToolExecutionOptions<CONTEXT>` carries a
            // required `context` — the SDK's own per-call context mechanism, which
            // is separate from ours: our tools read the ctx off the tool object via
            // `__acceptsCtx` / `getCtx(this)`, which is what `toolCtx` above is
            // doing. Nothing here uses the SDK's, so it is empty rather than
            // duplicated.
            const output = await wrappedTool.execute?.call(wrappedTool, toolInput, {
                context: {},
                messages: [],
                toolCallId,
            });

            toolResult.push({
                output: await createToolModelOutput({
                    errorMode: "none",
                    input: toolInput,
                    output,
                    tool,
                    toolCallId,
                }),
                toolCallId,
                toolName,
                type: "tool-result" as const,
            });
        } catch (error) {
            toolResult.push({
                output: {
                    type: "error-text",
                    value: error instanceof Error ? error.message : String(error),
                },
                toolCallId,
                toolName,
                type: "tool-result" as const,
            });
            console.error("Tool execution error:", error);
        }

        // Save approval response and tool result together
        const { messageId: toolResultId } = await this.saveMessage(ctx, {
            message: {
                content: toolResult,
                role: "tool",
            },
            promptMessageId: parentMessageId,
            skipEmbeddings: true,
            threadId,
        });

        // Continue generation with forceNewOrder to create a separate message.
        //
        // The cast below is the one thing here worth explaining. `streamText`
        // returns `StreamTextResult<TOOLS extends undefined ? AgentTools : TOOLS, …>`;
        // instantiating TOOLS as `AgentTools` leaves a DEFERRED conditional,
        // because TypeScript will not reduce `T extends undefined ? A : A` while
        // `T` is an unbound class parameter. So the result is provably the declared
        // type and is not assignable to it. Dropping the explicit generic does not
        // help either — TOOLS is then inferred from `streamTextArgs.tools`.
        return (await this.streamText<AgentTools>(
            ctx,
            { threadId },
            // Same deferred-conditional story on the way IN: the parameter type is
            // `StreamingTextArgs<TOOLS extends undefined ? AgentTools : TOOLS>`, and
            // `streamTextArgs` here is typed against the plain `AgentTools`.
            { ...streamTextArgs, forceNewOrder: true, promptMessageId: toolResultId } as never,
            {
                ...options,
                saveStreamDeltas: options?.saveStreamDeltas ?? { chunking: "word", throttleMs: 100 },
            },
        )) as unknown as GenerationOutputMetadata & StreamTextResult<AgentTools, AiContext, never>;
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
        const { approvalId, reason, threadId } = args;

        const toolInfo = await this._findToolCallInfo(ctx, threadId, approvalId);

        if (!toolInfo) {
            throw new Error(`Could not find tool call for approval ID: ${approvalId}`);
        }

        if (toolInfo.alreadyHandled) {
            if (!toolInfo.wasApproved) {
                throw new Error(`Tool call was already denied for approval ID: ${approvalId}`);
            }

            throw new Error(`Cannot deny tool call that was already approved for approval ID: ${approvalId}`);
        }

        const { parentMessageId, toolCallId, toolName } = toolInfo;
        const denialReason = reason ?? "Tool execution was denied by the user";

        // Save approval response (denied) and tool result with execution-denied
        const { messageId: toolResultId } = await this.saveMessage(ctx, {
            message: {
                content: [
                    {
                        approvalId,
                        approved: false,
                        reason: denialReason,
                        type: "tool-approval-response",
                    },
                    {
                        output: {
                            reason: denialReason,
                            type: "execution-denied",
                        },
                        toolCallId,
                        toolName,
                        type: "tool-result",
                    },
                ],
                role: "tool",
            },
            promptMessageId: parentMessageId,
            skipEmbeddings: true,
            threadId,
        });

        // Continue generation with forceNewOrder to create a separate message
        return this.streamText(
            ctx,
            { threadId },
            // `as never`: the same deferred-conditional parameter type as in `approveToolCall`.
            { ...streamTextArgs, forceNewOrder: true, promptMessageId: toolResultId } as never,
            {
                ...options,
                saveStreamDeltas: options?.saveStreamDeltas ?? { chunking: "word", throttleMs: 0 },
            },
        );
    }

    /**
     * Find tool call information for an approval ID.
     * Returns either:
     * - Tool info if approval is pending
     * - { alreadyHandled: true, wasApproved } if already approved/denied
     * - null if approval request not found.
     * @internal
     */
    private async _findToolCallInfo(
        context: ActionContext,
        threadId: string,
        approvalId: string,
    ): Promise<
        | {
              alreadyHandled?: false;
              parentMessageId: string;
              toolCallId: string;
              toolInput: Record<string, JSONValue>;
              toolName: string;
          }
        | { alreadyHandled: true; wasApproved: boolean }
        | null
    > {
        // Walk all pages until we find an existing response (already handled),
        // the originating approval request, and the matching tool-call. A
        // 20-message window would silently miss approvals that scrolled out
        // for long-running threads or slow human review.
        const allMessages: Awaited<ReturnType<typeof this.listMessages>>["page"] = [];
        let cursor: string | null = null;
        const PAGE_SIZE = 100;
        const MAX_MESSAGES = 5000;

        while (allMessages.length < MAX_MESSAGES) {
            const messagesResult = await this.listMessages(context, {
                paginationOpts: { cursor, numItems: PAGE_SIZE },
                threadId,
            });

            allMessages.push(...messagesResult.page);

            if (messagesResult.isDone || !messagesResult.continueCursor) break;

            cursor = messagesResult.continueCursor;
        }

        // First, check if this approval has already been handled
        for (const message of allMessages) {
            if (message.message?.role === "tool" && Array.isArray(message.message.content)) {
                for (const part of message.message.content) {
                    if (part.type === "tool-approval-response" && part.approvalId === approvalId) {
                        return { alreadyHandled: true, wasApproved: part.approved === true };
                    }
                }
            }
        }

        let toolCallId: string | undefined;
        let parentMessageId: string | undefined;

        // Second pass: find the approval request to get toolCallId and parent message
        for (const message of allMessages) {
            if (message.message?.role === "assistant" && Array.isArray(message.message.content)) {
                for (const part of message.message.content) {
                    if (part.type === "tool-approval-request" && part.approvalId === approvalId) {
                        parentMessageId = message._id;
                        toolCallId = part.toolCallId;
                        break;
                    }
                }
            }

            if (toolCallId) {
                break;
            }
        }

        if (!toolCallId || !parentMessageId) {
            return null;
        }

        let toolName: string | undefined;
        let toolInput: Record<string, JSONValue> | undefined;

        // Third pass: find the tool-call with matching toolCallId to get toolName and input
        for (const message of allMessages) {
            if (message.message?.role === "assistant" && Array.isArray(message.message.content)) {
                for (const part of message.message.content) {
                    if (part.type === "tool-call" && part.toolCallId === toolCallId) {
                        toolName = part.toolName;
                        // `input` is `v.any()` in the message schema — the stored
                        // tool arguments have no narrower type than a JSON object.
                        toolInput = (part.input ?? {}) as Record<string, JSONValue>;
                        break;
                    }
                }
            }

            if (toolName) {
                break;
            }
        }

        if (!toolName || !toolInput) {
            return null;
        }

        return { parentMessageId, toolCallId, toolInput, toolName };
    }
}
