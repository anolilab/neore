import type { Context as AiContext } from "@ai-sdk/provider-utils";
import { getErrorMessage } from "@ai-sdk/provider-utils";
import type { StepResult, StreamTextResult, ToolSet, UIMessage as AIUIMessage } from "ai";
import { streamText as streamTextAi } from "ai";

import { compressContextMessages, getModelContextWindow, isContextExceededError } from "../../chat/lib/auto-continue";
import { getModelName, getProviderName } from "../shared";
import type { Agent } from "./index";
import startGeneration from "./start";
import { compressUIMessageChunks, DeltaStreamer, mergeTransforms, type StreamingOptions } from "./streaming";
import type { ActionCtx as ActionContext, AgentComponent, AgentPrompt, GenerationOutputMetadata, Options, Output } from "./types";
import { willContinue } from "./utilities";

/**
 * This behaves like {@link streamText} from the "ai" package except that
 * it add context based on the userId and threadId and saves the input and
 * resulting messages to the thread, if specified.
 * Use {@link continueThread} to get a version of this function already scoped
 * to a thread (and optionally userId).
 */
const streamText = async <TOOLS extends ToolSet, OUTPUT extends Output<any, any, any> = never>(
    context: ActionContext,
    component: AgentComponent,

    /**
     * The arguments to the streamText function, similar to the ai sdk's
     * {@link streamText} function, along with Agent prompt options.
     */
    streamTextArgs: AgentPrompt &
        Omit<Parameters<typeof streamTextAi<TOOLS, AiContext, OUTPUT>>[0], "model" | "prompt" | "messages"> & {
            /**
             * The tools to use for the tool calls. This will override tools specified
             * in the Agent constructor or createThread / continueThread.
             */
            tools?: TOOLS;
        },

    /**
     * The {@link ContextOptions} and {@link StorageOptions}
     * options to use for fetching contextual messages and saving input/output messages.
     */
    options: Options & {
        agentForToolCtx?: Agent;
        agentName: string;

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
        threadId?: string;
        userId?: string | null;
    },
): Promise<GenerationOutputMetadata & StreamTextResult<TOOLS, AiContext, OUTPUT>> => _doStreamText(context, component, streamTextArgs, options, false);

const _doStreamText = async <TOOLS extends ToolSet, OUTPUT extends Output<any, any, any> = never>(
    context: ActionContext,
    component: AgentComponent,
    streamTextArgs: AgentPrompt &
        Omit<Parameters<typeof streamTextAi<TOOLS, AiContext, OUTPUT>>[0], "model" | "prompt" | "messages"> & {
            tools?: TOOLS;
        },
    options: Options & {
        agentForToolCtx?: Agent;
        agentName: string;
        saveStreamDeltas?: boolean | StreamingOptions;
        threadId?: string;
        userId?: string | null;
    },
    isRetry: boolean,
): Promise<GenerationOutputMetadata & StreamTextResult<TOOLS, AiContext, OUTPUT>> => {
    const { threadId } = options ?? {};
    const { args, order, promptMessageId, stepOrder, userId, ...call } = await startGeneration(context, component, streamTextArgs, options);

    const steps: StepResult<TOOLS>[] = [];

    const streamer =
        threadId && options.saveStreamDeltas
            ? new DeltaStreamer(
                  component,
                  context,
                  {
                      abortSignal: args.abortSignal,
                      compress: compressUIMessageChunks,
                      onAsyncAbort: call.fail,
                      throttleMs: typeof options.saveStreamDeltas === "object" ? options.saveStreamDeltas.throttleMs : undefined,
                  },
                  {
                      agentName: options?.agentName,
                      format: "UIMessageChunk",
                      model: getModelName(args.model),
                      order,
                      provider: getProviderName(args.model),
                      providerOptions: args.providerOptions,
                      stepOrder,
                      threadId,
                      userId,
                  },
              )
            : undefined;

    // Track whether the error was a context-exceeded error (for retry logic)
    let isContextExceededDetected = false;

    const result = streamTextAi<TOOLS, AiContext, OUTPUT>({
        ...args,
        abortSignal: streamer?.abortController.signal ?? args.abortSignal,
        experimental_transform: mergeTransforms(options?.saveStreamDeltas, streamTextArgs.experimental_transform),
        onError: async (error) => {
            const errorMessage = getErrorMessage(error.error);

            // On first attempt, check if this is a context-exceeded error we can retry
            if (!isRetry && isContextExceededError(errorMessage)) {
                console.warn("[streamText] Context exceeded detected, will retry with compressed messages");
                isContextExceededDetected = true;
                // Don't fail the call yet — the retry will handle it.
                // Still notify the streamer so the client sees the retry happening.
                await streamer?.fail("Context exceeded — retrying with compression...");

                return streamTextArgs.onError?.(error);
            }

            console.error("onError", error);
            await call.fail(errorMessage);
            await streamer?.fail(errorMessage);

            return streamTextArgs.onError?.(error);
        },
        onStepFinish: async (step) => {
            steps.push(step);
            const shouldCreatePendingMessage = await willContinue(steps, args.stopWhen);

            await call.save({ step }, shouldCreatePendingMessage);

            return args.onStepFinish?.(step);
        },
        prepareStep: async (callOptions) => {
            const stepResult = await streamTextArgs.prepareStep?.(callOptions);

            if (stepResult) {
                const model = stepResult.model ?? callOptions.model;

                call.updateModel(model);

                return stepResult;
            }

            return undefined;
        },
    }) as StreamTextResult<TOOLS, AiContext, OUTPUT>;
    const stream = streamer?.consumeStream(result.toUIMessageStream<AIUIMessage<TOOLS>>());
    let isStreamConsumed = false;

    try {
        if ((typeof options?.saveStreamDeltas === "object" && !options.saveStreamDeltas.returnImmediately) || options?.saveStreamDeltas === true) {
            await stream;
            await result.consumeStream();
            isStreamConsumed = true;
        }
    } catch (error) {
        // Auto-retry on context exceeded: compress messages and try once more
        if (isContextExceededDetected && !isRetry) {
            console.warn("[streamText] Retrying with aggressively compressed context");

            // Fail the pending message from the first attempt so a fresh one is created
            await call.fail("Context exceeded — retrying with compression");

            // Compress the messages that were too large
            const modelId = getModelName(args.model);
            const contextWindow = getModelContextWindow(modelId);
            const compressed = compressContextMessages(args.messages, contextWindow);

            // Override the prompt with compressed messages for the retry
            const retryArgs = {
                ...streamTextArgs,
                messages: compressed,
                prompt: undefined,
                promptMessageId: undefined,
            } as typeof streamTextArgs;

            return _doStreamText(context, component, retryArgs, options, true);
        }

        // If an error occurs during streaming (e.g., in onStepFinish callbacks),
        // make sure to abort the streaming message so it doesn't get stuck
        if (streamer && !isStreamConsumed) {
            await streamer.fail(getErrorMessage(error));
        }

        throw error;
    }

    const metadata: GenerationOutputMetadata = {
        order,
        promptMessageId,
        savedMessages: call.getSavedMessages(),
    };

    return Object.assign(result, metadata);
};

export default streamText;
