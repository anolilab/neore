import type { ImageModelV3, JSONValue } from "@ai-sdk/provider";
import type { Context as AiContext } from "@ai-sdk/provider-utils";
import type { FlexibleSchema, InferSchema, ModelMessage } from "@ai-sdk/provider-utils";
import type {
    CallSettings,
    CallWarning,
    EmbeddingModel,
    GenerateObjectResult,
    generateText,
    GenerateTextResult,
    LanguageModel,
    LanguageModelRequestMetadata,
    LanguageModelResponseMetadata,
    LanguageModelUsage,
    streamText,
    StreamTextResult,
    ToolSet,
} from "ai";

import type { api } from "../../_generated/api";
import type { ActionCtx as LunoraActionContext, MutationCtx as LunoraMutationContext, QueryCtx as LunoraQueryContext } from "../../_generated/server";
import type { MessageDoc, ProviderMetadata, StreamDelta, StreamMessage, ThreadDoc } from "../validators";
import type { StreamingOptions } from "./streaming";

export interface Output<_T = any, _P = any, _E = any> {
    createElementStreamTransform: any;
    name: string;
    parseCompleteOutput: any;
    parsePartialOutput: any;
    responseFormat: any;
}

export type AgentPrompt = {
    /**
     * If true, the new message will get a fresh order (one higher than the max
     * existing order) instead of using the promptMessageId's order. Useful for
     * continuing generation after tool approval where you want the continuation
     * to be a separate message from the original tool call.
     */
    forceNewOrder?: boolean;

    /**
     * A list of messages to use as context before the prompt.
     * If used with `prompt`, these will precede the prompt.
     * If used with the storageOptions "promptAndOutput" (default),
     * none of these messages will be saved.
     */
    messages?: ModelMessage[];

    /**
     * The model to use for the LLM calls. This will override the languageModel
     * specified in the Agent config.
     */
    model?: LanguageModel;

    /**
     * A prompt. It can be either a text prompt or a list of messages.
     * If used with `promptMessageId`, it will be used in place of that
     * prompt message and no input messages will be saved.
     * Otherwise, if used with the storageOptions "promptAndOutput" (default),
     * it will be the only message saved.
     * If a string is provided, it will be a user message.
     */
    prompt?: string | ModelMessage[];

    /**
     * If provided, it uses this existing message to anchor the prompt:
     * - The specified message will be included, unless `prompt` is also
     *   provided, in which case that will be inserted in place of this
     *   specified message.
     * - Recent and search messages will not include messages after this
     *   message's order.
     * - If there are already responses on the same order,
     *   for example, tool calls and responses,
     *   those will be included automatically.
     *
     * Note: if this is provided, no input messages will be saved by default.
     */
    promptMessageId?: string;

    /**
     * System message to include in the prompt. Overwrites Agent instructions.
     */
    system?: string;
};

export type Config = {
    /**
     * The default settings to use for the LLM calls.
     * This can be overridden at each generate/stream callsite on a per-field
     * basis. To clear a default setting, you'll need to pass `undefined`.
     */
    callSettings?: CallSettings;

    /**
     * By default, messages are ordered with context in `fetchContextWithPrompt`,
     * but you can override this by providing a context handler. Here you can
     * filter, modify, or enrich the context messages. If provided, the default
     * ordering will not apply. This excludes the system message / instructions.
     */
    contextHandler?: ContextHandler;

    /**
     * Options to determine what messages are included as context in message
     * generation. To disable any messages automatically being added, pass:
     * { recentMessages: 0 }
     */
    contextOptions?: ContextOptions;

    /**
     * The model to use for text embeddings. Optional.
     * If specified, it will use this for generating vector embeddings
     * of chats, and can opt-in to doing vector search for automatic context
     * on generateText, etc.
     * e.g.
     * import { openai } from "@ai-sdk/openai"
     * const myAgent = new Agent(components.agent, {
     *   ...
     *   embeddingModel: openai.embedding("text-embedding-3-small")
     */
    embeddingModel?: EmbeddingModel;

    /**
     * The LLM model to use for generating / streaming text and objects.
     * Requires AI SDK v6 (@ai-sdk/* packages v3.x).
     * @example
     * import { openai } from "@ai-sdk/openai"
     * const myAgent = new Agent(components.agent, {
     *   languageModel: openai.chat("gpt-4o-mini"),
     * })
     */
    languageModel?: LanguageModel | ImageModelV3;

    /**
     * The maximum number of steps to allow for a single generation.
     *
     * For example, if an agent wants to call a tool, that call and tool response
     * will be one step. Generating a response based on the tool call & response
     * will be a second step.
     * If it runs out of steps, it will return the last step result, which may
     * not be an assistant message.
     *
     * This becomes the default value when `stopWhen` is not specified in the
     * Agent or generation callsite.
     * AI SDK v5 removed the `maxSteps` argument, but this is kept here for
     * convenience and backwards compatibility.
     * Defaults to 1.
     */
    maxSteps?: number;

    /**
     * Provider-specific options to pass to the LLM.
     * E.g. for OpenAI, you might pass { openai: { reasoningEffort: "high" } }.
     */
    providerOptions?: Record<string, Record<string, JSONValue>>;

    /**
     * Called for each LLM request/response, so you can do things like
     * log the raw request body or response headers to a table, or logs.
     */
    rawRequestResponseHandler?: RawRequestResponseHandler;

    /**
     * If true, skip all context fetching (search, recent messages, existing responses).
     * Only the current input messages will be sent to the LLM.
     */
    statelessMode?: boolean;

    /**
     * Determines whether messages are automatically stored when passed as
     * arguments or generated.
     */
    storageOptions?: StorageOptions;

    /**
     * The usage handler to use for this agent.
     */
    usageHandler?: UsageHandler;
};

/**
 * Options to configure what messages are fetched as context,
 * automatically with thread.generateText, or directly via search.
 */
export type ContextOptions = {
    /**
     * Whether to include tool messages in the context.
     * By default, tool calls and results are not included.
     */
    excludeToolMessages?: boolean;

    /**
     * How many recent messages to include. These are added after the search
     * messages, and do not count against the search limit.
     * Default: 100
     */
    recentMessages?: number;

    /**
     * Options for searching messages.
     */
    searchOptions?: {
        /**
         * The maximum number of messages to fetch. Default is 10.
         */
        limit: number;

        /**
         * What messages around the search results to include.
         * Default: { before: 2, after: 1 }
         * (two before, and one after each message found in the search)
         * Note, this is after the limit is applied.
         * By default this will quadruple the number of messages fetched.
         */
        messageRange?: { after: number; before: number };

        /**
         * Whether to use text search to find messages. Default is false.
         */
        textSearch?: boolean;

        /**
         * The score threshold for vector search. Default is 0.0.
         */
        vectorScoreThreshold?: number;

        /**
         * Whether to use vector search to find messages. Default is false.
         * At least one of textSearch or vectorSearch must be true.
         */
        vectorSearch?: boolean;
    };

    /**
     * Whether to search across other threads for relevant messages.
     * By default, only the current thread is searched.
     */
    searchOtherThreads?: boolean;
};

/**
 * Options to configure the automatic saving of messages
 * when generating text / objects in a thread.
 */
export type StorageOptions = {
    /**
     * Whether to save messages to the thread history.
     * Pass "all" to save all input and output messages.
     * Pass "none" to not save any input or output messages.
     * Pass "promptAndOutput" to save the prompt and all output messages.
     * If you pass {messages} but no {prompt}, it will assume messages.at(-1) is
     * the prompt.
     * Defaults to "promptAndOutput".
     */
    saveMessages?: "all" | "none" | "promptAndOutput";
};

export type GenerationOutputMetadata = {
    /**
     * The order of the prompt message and responses for the generation.
     * Each order starts with a user message, then followed by agent responses.
     * If a promptMessageId is provided, that dictates the order.
     */
    order?: number;

    /**
     * The ID of the prompt message for the generation.
     */
    promptMessageId?: string;

    /**
     * The messages saved for the generation - both saved input and output.
     * If you passed promptMessageId, it will not include that message.
     */
    savedMessages?: MessageDoc[];
};

export type UsageHandler = (
    // `RunnerCtx` too: this is reached from the embedding path, which an HTTP
    // handler can be on, and recording usage goes through `runMutation` — there is
    // no reason for it to demand a storage-capable context.
    context: ActionCtx | RunnerCtx,
    args: {
        agentName: string | undefined;
        model: string;
        provider: string;
        // Often has more information, like cached token usage in the case of openai.
        providerMetadata: ProviderMetadata | undefined;
        threadId: string | undefined;
        usage: LanguageModelUsage;
        userId: string | undefined;
    },
) => void | Promise<void>;

/**
 * By default, messages are ordered with context in `fetchContextWithPrompt`,
 * but you can override this by providing a context handler. Here you can filter
 * out, add in, or reorder messages.
 */
export type ContextHandler = (
    context: ActionCtx,
    args: {
        /**
         * All messages in the default order.
         */
        allMessages: ModelMessage[];

        /**
         * Any messages on the same `order` as the promptMessageId message after the
         * prompt message. These are presumably existing responses to the prompt
         * message.
         */
        existingResponses: ModelMessage[];

        /**
         * The messages passed as the `messages` argument to e.g. generateText.
         */
        inputMessages: ModelMessage[];

        /**
         * The message(s) passed as the `prompt` argument to e.g. generateText.
         * Otherwise, if `promptMessageId` was provided, the message at that id.
         * `prompt` will override the message at `promptMessageId`.
         */
        inputPrompt: ModelMessage[];

        /**
         * The recent messages already in the thread history,
         * excluding any messages that came after promptMessageId.
         */
        recent: ModelMessage[];

        /**
         * The messages fetched from search.
         */
        search: ModelMessage[];

        /**
         * The thread associated with the generation, if any.
         */
        threadId: string | undefined;

        /**
         * The user associated with the generation, if any.
         */
        userId: string | undefined;
    },
) => ModelMessage[] | Promise<ModelMessage[]>;

export type RawRequestResponseHandler = (
    context: ActionCtx,
    args: {
        agentName: string | undefined;
        request: LanguageModelRequestMetadata;

        /**
         * `messages` is absent on the object-generation path.
         * `GenerateObjectResult["response"]` is `Omit<LanguageModelResponseMetadata,
         * "messages">`, and `start.ts` passes whichever of the two it has. Declaring
         * only the full shape made that call unassignable while claiming to handlers
         * that `messages` is always there — it is not.
         */
        response: LanguageModelResponseMetadata | Omit<LanguageModelResponseMetadata, "messages">;
        threadId: string | undefined;
        userId: string | undefined;
    },
) => void | Promise<void>;

/**
 * The agent component API type.
 * Uses the direct API pattern after migration - references api.agent directly.
 */
// Lunora flattens the api namespace — the old path was `api.agent.*`,
// which here is spread across `api.agent.messages`, `api.agent.threads`, etc.
// The component surface is the whole generated api.
export type AgentComponent = typeof api;

export type TextArgs<AgentTools extends ToolSet, TOOLS extends ToolSet | undefined = undefined, OUTPUT extends Output<any, any, any> = never> = AgentPrompt &
    Omit<Parameters<typeof generateText<TOOLS extends undefined ? AgentTools : TOOLS, AiContext, OUTPUT>>[0], "model" | "prompt" | "messages"> & {
        /**
         * The tools to use for the tool calls. This will override tools specified
         * in the Agent constructor or createThread / continueThread.
         */
        tools?: TOOLS;
    };

export type StreamingTextArgs<
    AgentTools extends ToolSet,
    TOOLS extends ToolSet | undefined = undefined,
    OUTPUT extends Output<any, any, any> = never,
> = AgentPrompt &
    Omit<Parameters<typeof streamText<TOOLS extends undefined ? AgentTools : TOOLS, AiContext, OUTPUT>>[0], "model" | "prompt" | "messages"> & {
        /**
         * The tools to use for the tool calls. This will override tools specified
         * in the Agent constructor or createThread / continueThread.
         */
        tools?: TOOLS;
    };

export type ObjectMode = "object" | "array" | "enum" | "no-schema";

/**
 * Base arguments for structured output generation.
 * Used with AI SDK v6 Output API (generateText/streamText with Output.object/array/choice).
 */
type StructuredOutputBaseArgs = Omit<Parameters<typeof generateText>[0], "model" | "prompt" | "messages" | "output">;

export type GenerateObjectArgs<
    SCHEMA extends FlexibleSchema<unknown> = FlexibleSchema<JSONValue>,
    OUTPUT extends ObjectMode = InferSchema<SCHEMA> extends string ? "enum" : "object",
    RESULT = OUTPUT extends "array" ? InferSchema<SCHEMA>[] : InferSchema<SCHEMA>,
> = AgentPrompt &
    StructuredOutputBaseArgs & {
        /** The enum values for choice output */
        enum?: RESULT[];
        /** The output mode: "object", "array", "enum", or "no-schema" */
        mode?: OUTPUT;
        /** The Zod schema for object/array output */
        schema?: SCHEMA;
    };

export type StreamObjectArgs<
    SCHEMA extends FlexibleSchema<unknown> = FlexibleSchema<JSONValue>,
    OUTPUT extends ObjectMode = InferSchema<SCHEMA> extends string ? "enum" : "object",
    RESULT = OUTPUT extends "array" ? InferSchema<SCHEMA>[] : InferSchema<SCHEMA>,
> = AgentPrompt &
    StructuredOutputBaseArgs & {
        /** The enum values for choice output */
        enum?: RESULT[];
        /** The output mode: "object", "array", "enum", or "no-schema" */
        mode?: OUTPUT;
        /** Callback when an error occurs during streaming */
        onError?: (error: { error: unknown }) => void | Promise<void>;
        /** Callback when streaming finishes */
        onFinish?: (result: {
            error?: unknown;
            object: RESULT;
            providerMetadata?: Record<string, JSONValue>;
            response: LanguageModelResponseMetadata;
            usage: LanguageModelUsage;
            warnings?: any[];
        }) => void | Promise<void>;
        /** The Zod schema for object/array output */
        schema?: SCHEMA;
    };

export type MaybeCustomCtx<CustomContext, AgentTools extends ToolSet> =
    CustomContext extends Record<string, unknown>
        ? {
              /**
               * If you have a custom ctx that you use with the Agent
               * (e.g. new Agent<{ orgId: string }>(...))
               * you need to provide this function to add any extra fields.
               * e.g.
               * ```ts
               * const myAgent = new Agent<{ orgId: string }>(...);
               * const myAction = myAgent.asTextAction({
               *   customCtx: (ctx: ActionCtx, target, llmArgs) => {
               *     const orgId = await lookupOrgId(ctx, target.threadId);
               *     return { orgId };
               *   },
               * });
               * ```
               * Then, in your tools, you can
               */
              customCtx: (
                  context: LunoraActionContext,
                  target: {
                      threadId?: string;
                      userId?: string;
                  },
                  llmArgs: TextArgs<AgentTools>,
              ) => CustomContext;
          }
        : { customCtx?: never };

type ThreadOutputMetadata = Required<GenerationOutputMetadata>;

/**
 * The interface for a thread returned from {@link createThread} or {@link continueThread}.
 * This is contextual to a thread and/or user.
 */
export interface Thread<DefaultTools extends ToolSet> {
    /**
     * This behaves like {@link generateObject} from the "ai" package except that
     * it add context based on the userId and threadId and saves the input and
     * resulting messages to the thread, if specified. This overload is for objects, arrays, and enums.
     * Use {@link continueThread} to get a version of this function already scoped
     * to a thread (and optionally userId).
     * for the {@link ContextOptions} and {@link StorageOptions}.
     * @returns The result of the generateObject function.
     */
    generateObject: <
        SCHEMA extends FlexibleSchema<unknown> = FlexibleSchema<JSONValue>,
        OUTPUT extends ObjectMode = InferSchema<SCHEMA> extends string ? "enum" : "object",
        RESULT = OUTPUT extends "array" ? InferSchema<SCHEMA>[] : InferSchema<SCHEMA>,
    >(
        generateObjectArgs: AgentPrompt & GenerateObjectArgs<SCHEMA, OUTPUT, RESULT>,
        options?: Options,
    ) => Promise<GenerateObjectResult<RESULT> & ThreadOutputMetadata>;

    /**
     * This behaves like {@link generateText} from the "ai" package except that
     * it add context based on the userId and threadId and saves the input and
     * resulting messages to the thread, if specified.
     * Use {@link continueThread} to get a version of this function already scoped
     * to a thread (and optionally userId).
     * for the {@link ContextOptions} and {@link StorageOptions}.
     * @returns The result of the generateText function.
     */
    generateText: <TOOLS extends ToolSet | undefined = undefined, OUTPUT extends Output<any, any, any> = never>(
        generateTextArgs: AgentPrompt & TextArgs<TOOLS extends undefined ? DefaultTools : TOOLS, TOOLS, OUTPUT>,
        options?: Options,
    ) => Promise<GenerateTextResult<TOOLS extends undefined ? DefaultTools : TOOLS, AiContext, OUTPUT> & ThreadOutputMetadata>;

    /**
     * Get the metadata for the thread.
     */
    getMetadata: () => Promise<ThreadDoc>;

    /**
     * This behaves like streamObject from the "ai" package except that
     * it add context based on the userId and threadId and saves the input and
     * resulting messages to the thread, if specified.
     * Use {@link continueThread} to get a version of this function already scoped
     * to a thread (and optionally userId).
     *
     * Note: Internally uses AI SDK v6 Output API (streamText with Output.object/array/choice).
     * for the {@link ContextOptions} and {@link StorageOptions}.
     * @returns The streaming result with partialObjectStream and object properties.
     */
    streamObject: <
        SCHEMA extends FlexibleSchema<unknown> = FlexibleSchema<JSONValue>,
        OUTPUT extends ObjectMode = InferSchema<SCHEMA> extends string ? "enum" : "object",
        RESULT = OUTPUT extends "array" ? InferSchema<SCHEMA>[] : InferSchema<SCHEMA>,
    >(
        /**
         * The arguments for structured output streaming.
         */
        streamObjectArgs: AgentPrompt & StreamObjectArgs<SCHEMA, OUTPUT, RESULT>,
        options?: Options,
    ) => Promise<StreamObjectResult<RESULT> & ThreadOutputMetadata>;

    /**
     * This behaves like {@link streamText} from the "ai" package except that
     * it add context based on the userId and threadId and saves the input and
     * resulting messages to the thread, if specified.
     * Use {@link continueThread} to get a version of this function already scoped
     * to a thread (and optionally userId).
     * for the {@link ContextOptions} and {@link StorageOptions}.
     * @returns The result of the streamText function.
     */
    streamText: <TOOLS extends ToolSet | undefined = undefined, OUTPUT extends Output<any, any, any> = never>(
        streamTextArgs: AgentPrompt & StreamingTextArgs<TOOLS extends undefined ? DefaultTools : TOOLS, TOOLS, OUTPUT>,
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
    ) => Promise<StreamTextResult<TOOLS extends undefined ? DefaultTools : TOOLS, AiContext, OUTPUT> & ThreadOutputMetadata>;

    /**
     * The target threadId, from the startThread or continueThread initializers.
     */
    threadId: string;

    /**
     * Update the metadata for the thread.
     */
    updateMetadata: (patch: Partial<Omit<ThreadDoc, "_creationTime" | "_id">>) => Promise<ThreadDoc>;
}

/**
 * Result type for streamObject method.
 * Provides backward-compatible interface when using AI SDK v6 Output API internally.
 */
export interface StreamObjectResult<RESULT> {
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

export type Options = {
    /**
     * By default, messages are ordered with context in `fetchContextWithPrompt`,
     * but you can override this by providing a context handler. Here you can
     * filter, modify, or enrich the context messages. If provided, the default
     * ordering will not apply. This excludes the system message / instructions.
     */
    contextHandler?: ContextHandler;

    /**
     * The context options to use for passing in message history to the LLM.
     */
    contextOptions?: ContextOptions;

    /**
     * If true, skip all context fetching (search, recent messages, existing responses).
     * Only the current input messages will be sent to the LLM.
     * This overrides the agent-level statelessMode setting.
     */
    statelessMode?: boolean;

    /**
     * The storage options to use for saving the input and output messages to the thread.
     */
    storageOptions?: StorageOptions;

    /**
     * The usage handler to use for this thread. Overrides any handler
     * set in the agent constructor.
     */
    usageHandler?: UsageHandler;
};

export type SyncStreamsReturnValue = { kind: "list"; messages: StreamMessage[] } | { deltas: StreamDelta[]; kind: "deltas" } | undefined;

/* Type utils follow */

/**
 * The three context shapes the agent's overloads discriminate on.
 *
 * These used to be `Pick<GenericActionCtx<…>, …>` etc. from a compatibility module,
 * whose properties are ALL OPTIONAL — so `ActionCtx` was satisfied by `{}`, and
 * so was `MutationCtx`, and so overload resolution between them was arbitrary.
 * `agent.createThread(ctx, …)` inside an `internalAction` picked the MUTATION
 * overload and returned `{ threadId }` with no `thread`, in two callers.
 *
 * Taken from Lunora's generated contexts instead, the distinction is real:
 * an action has `runAction` and no `db`, a mutation has a writable `db`, a query
 * has a reader. The `Pick` still keeps the surface narrow — the agent only ever
 * uses these members — but the members now have shapes that tell the three
 * apart.
 */
export type QueryCtx = Pick<LunoraQueryContext, "db" | "runQuery">;
export type MutationCtx = Pick<LunoraMutationContext, "db" | "runMutation" | "runQuery">;
export type ActionCtx = Pick<LunoraActionContext, "auth" | "runAction" | "runMutation" | "runQuery" | "storage">;

/**
 * An action context that cannot reach storage.
 *
 * Lunora types an HTTP handler's ctx as
 * `Pick<ActionCtx, "auth" | "cache" | "fetch" | "runAction" | "runMutation" | "runQuery">`
 * — no `storage`, and no `db` — so it satisfies neither `ActionCtx` nor
 * `MutationCtx` here. That is correct for the file paths, which genuinely need
 * `ctx.storage`, but wrong for `saveMessage` / `updateMessage` / `continueThread`,
 * which only ever go through `runQuery` / `runMutation`. Those accept this
 * instead, so `chat/http.ts` can call them without a cast.
 */
export type RunnerCtx = Pick<LunoraActionContext, "runAction" | "runMutation" | "runQuery">;
