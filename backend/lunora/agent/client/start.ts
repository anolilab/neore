import {
    type CallSettings,
    type GenerateObjectResult,
    type IdGenerator,
    type LanguageModel,
    type ModelMessage,
    stepCountIs,
    type StepResult,
    type StopCondition,
    type ToolSet,
} from "ai";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import { applyLateCompression } from "../../chat/lib/auto-continue";
import { toUserFacingError } from "../../chat/lib/user-facing-error";
import { omit } from "../../lib/collections";
import { assert } from "../../lib/error-helpers";
import { serializeNewMessagesInStep, serializeObjectResult } from "../mapping";
import { continuationOrder } from "../branch-tree";
import { getModelName, getProviderName, type ModelOrMetadata } from "../shared";
import type { Message, MessageDoc } from "../validators";
import { type ToolCtx as ToolContext, wrapTools } from "./create-tool";
import type { Agent } from "./index";
import saveInputMessages from "./save-input-messages";
import { embedMessages, fetchContextWithPrompt } from "./search";
import type { ActionCtx as ActionContext, AgentComponent, Config, Options } from "./types";

const startGeneration = async <T, Tools extends ToolSet = ToolSet, CustomContext extends object = object>(
    context_: ActionContext & CustomContext,
    component: AgentComponent,

    /**
     * These are the arguments you'll pass to the LLM call such as
     * `generateText` or `streamText`. This function will look up the context
     * and provide functions to save the steps, abort the generation, and more.
     * The type of the arguments returned infers from the type of the arguments
     * you pass here.
     */
    args: T & {
        _internal?: { generateId?: IdGenerator };

        /**
         * The abort signal to be passed to the LLM call. If triggered, it will
         * mark the pending message as failed. If the generation is asynchronously
         * aborted, it will trigger this signal when detected.
         */
        abortSignal?: AbortSignal;

        /**
         * If true, the new message will get a fresh order (one higher than the max
         * existing order) instead of using the promptMessageId's order. Useful for
         * continuing generation after tool approval where you want the continuation
         * to be a separate message from the original tool call.
         */
        forceNewOrder?: boolean;

        /**
         * If provided alongside prompt, the ordering will be:
         * 1. system prompt
         * 2. search context
         * 3. recent messages
         * 4. these messages
         * 5. prompt messages, including those already on the same `order` as
         *   the promptMessageId message, if provided.
         */
        messages?: (ModelMessage | Message)[];

        /**
         * The model to use for the LLM calls. This will override the model specified
         * in the Agent constructor.
         */
        model?: LanguageModel;

        /**
         * The single prompt message to use for the LLM call. This will be the
         * last message in the context. If it's a string, it will be a user role.
         */
        prompt?: string | (ModelMessage | Message)[];

        /**
         * If provided, this message will be used as the "prompt" for the LLM call,
         * instead of the prompt or messages.
         * This is useful if you want to first save a user message, then use it as
         * the prompt for the LLM call in another call.
         */
        promptMessageId?: string;
        stopWhen?: StopCondition<Tools> | StopCondition<Tools>[];

        /**
         * The tools to use for the tool calls. This will override tools specified
         * in the Agent constructor or createThread / continueThread.
         */
        tools?: Tools;
    },
    {
        threadId,
        ...options
    }: Config &
        Options & {
            agentForToolCtx?: Agent;
            agentName: string;
            threadId?: string;
            userId?: string | null;
        },
): Promise<{
    args: CallSettings &
        T & {
            messages: ModelMessage[];
            model: LanguageModel;
            prompt?: never;
            system?: string;
            tools?: Tools;
        };
    fail: (reason: string) => Promise<void>;
    getSavedMessages: () => MessageDoc[];
    order: number;
    promptMessageId: string | undefined;
    save: <TOOLS extends ToolSet>(
        toSave: { step: StepResult<TOOLS> } | { object: GenerateObjectResult<unknown> },
        shouldCreatePendingMessage?: boolean,
    ) => Promise<void>;
    stepOrder: number;
    updateModel: (model: ModelOrMetadata | undefined) => void;
    userId: string | undefined;
}> => {
    // The thread read is hoisted out of the `??` chain rather than awaited inline.
    // The guard reproduces the short-circuit exactly: the query runs only when the
    // caller passed no userId (`undefined` or `null`) and there is a thread to read.
    const shouldReadThreadUser = (options.userId === undefined || options.userId === null) && Boolean(threadId);
    const threadForUserId = shouldReadThreadUser
        ? await context_.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> })
        : undefined;
    const userId = options.userId ?? (threadId && threadForUserId?.userId) ?? undefined;

    const context = await fetchContextWithPrompt(context_, component, {
        ...options,
        messages: args.messages,
        prompt: args.prompt,
        promptMessageId: args.promptMessageId,
        threadId,
        userId,
    });

    const saveMessages = options.storageOptions?.saveMessages ?? "promptAndOutput";
    // When forceNewOrder is true, skip creating a pendingMessage because it would
    // be created with the wrong order. The message will be created fresh when saved.
    const { pendingMessage, promptMessageId, savedMessages } =
        threadId && saveMessages !== "none" && !args.forceNewOrder
            ? await saveInputMessages(context_, {
                  ...options,
                  messages: args.messages,
                  prompt: args.prompt,
                  promptMessageId: args.promptMessageId,
                  storageOptions: { saveMessages },
                  threadId,
                  userId,
              })
            : {
                  pendingMessage: undefined,
                  promptMessageId: args.promptMessageId,
                  savedMessages: [] as MessageDoc[],
              };

    // Determine order for the new message
    // If forceNewOrder is set, increment from the context order to create a separate message
    let order = pendingMessage?.order ?? context.order;
    let stepOrder = pendingMessage?.stepOrder ?? context.stepOrder;
    const useForceNewOrder = args.forceNewOrder && order !== undefined;

    if (useForceNewOrder) {
        // Past EVERY row, not just past the prompt's: in a branched thread a
        // sibling branch may already occupy `order + 1` (see `branch-tree.ts`).
        const maxOrder = threadId ? await context_.runQuery(internal.agent.branches.getMaxOrder, { threadId: threadId as Id<"threads"> }) : undefined;

        // TypeScript can't infer order is defined here from the compound condition above
        order = continuationOrder(order!, maxOrder);
        stepOrder = 0;
    }

    let pendingMessageId = pendingMessage?._id;

    const model = args.model ?? options.languageModel;

    assert(model, "model is required");
    let activeModel: ModelOrMetadata = model;

    const fail = async (reason: string) => {
        if (!pendingMessageId) {
            return;
        }

        // The persisted error is shown to the user on every reload: raw provider
        // text stays in the logs (callers log it), the row gets our wording.
        const provider = typeof activeModel === "string" ? undefined : activeModel.provider;

        await context_.runMutation(internal.agent.messages.finalizeMessage, {
            messageId: pendingMessageId as Id<"messages">,
            result: { error: toUserFacingError(reason, { customEndpoint: provider === "gateway/custom" }), status: "failed" },
        });
    };

    if (args.abortSignal) {
        const { abortSignal } = args;

        abortSignal.addEventListener(
            "abort",
            async () => {
                await fail(abortSignal.reason?.toString() ?? "abortSignal");
            },
            { once: true },
        );
    }

    const toolContext = {
        ...(context_ as ActionContext & CustomContext),
        agent: options.agentForToolCtx,
        promptMessageId,
        threadId,
        userId,
    } satisfies ToolContext;
    const tools = wrapTools(toolContext, args.tools) as Tools;
    // Late compression: prevent context-exceeded errors by compressing messages
    // that are close to the model's context window limit before sending to LLM.
    const modelId = getModelName(model);
    const messages = applyLateCompression(context.messages, modelId);

    const aiArgs = {
        ...options.callSettings,
        providerOptions: options.providerOptions,
        ...omit(args, ["promptMessageId", "messages", "prompt"]),
        messages,
        model,
        stopWhen: args.stopWhen ?? (options.maxSteps ? stepCountIs(options.maxSteps) : undefined),
        tools,
    } as CallSettings &
        T & {
            _internal?: { generateId?: IdGenerator };
            messages: ModelMessage[];
            model: LanguageModel;
            prompt?: never;
            tools?: Tools;
        };

    if (pendingMessageId && !aiArgs._internal?.generateId) {
        aiArgs._internal = {
            ...aiArgs._internal,
            generateId: pendingMessageId ? () => pendingMessageId ?? crypto.randomUUID() : undefined,
        };
    }

    return {
        args: aiArgs,
        fail,
        getSavedMessages: () => savedMessages,
        order: order ?? 0,
        promptMessageId,
        save: async <TOOLS extends ToolSet>(
            toSave: { step: StepResult<TOOLS> } | { object: GenerateObjectResult<unknown> },
            shouldCreatePendingMessage?: boolean,
        ) => {
            if (threadId && saveMessages !== "none") {
                const serialized =
                    "object" in toSave
                        ? await serializeObjectResult(context_, toSave.object, activeModel)
                        : await serializeNewMessagesInStep(context_, toSave.step, activeModel);
                const embeddings = await embedMessages(
                    context_,
                    { threadId, ...options, userId },
                    serialized.messages.map((m) => m.message),
                );

                if (shouldCreatePendingMessage) {
                    serialized.messages.push({
                        message: { content: [], role: "assistant" },
                        status: "pending",
                    });
                    embeddings?.vectors.push(null);
                }

                const saved = await context_.runMutation(internal.agent.messages.addMessages, {
                    agentName: options.agentName,
                    embeddings,
                    failPendingSteps: false,
                    messages: serialized.messages as any, // Messages with string IDs cast to proper schema
                    // Pass the computed order when forceNewOrder is true
                    overrideOrder: useForceNewOrder ? order : undefined,
                    // The continuation's fresh order has no row before it on its
                    // branch, so its first row names the tool result it continues.
                    parentMessageId: useForceNewOrder ? promptMessageId : undefined,
                    pendingMessageId: pendingMessageId as Id<"messages"> | undefined,
                    // When forceNewOrder is true, don't pass promptMessageId and use overrideOrder
                    // to ensure the continuation message gets a fresh order (N+1)
                    promptMessageId: (useForceNewOrder ? undefined : promptMessageId) as Id<"messages"> | undefined,
                    threadId: threadId as Id<"threads">,
                    userId,
                });
                const lastMessage = saved.messages.at(-1)!;

                if (shouldCreatePendingMessage) {
                    if (lastMessage.status === "failed") {
                        pendingMessageId = undefined;
                        savedMessages.push(...saved.messages);
                        await fail(lastMessage.error ?? "Aborting - the pending message was marked as failed");
                    } else {
                        pendingMessageId = lastMessage._id;
                        savedMessages.push(...saved.messages.slice(0, -1));
                    }
                } else {
                    pendingMessageId = undefined;
                    savedMessages.push(...saved.messages);
                }
            }

            const output = "object" in toSave ? toSave.object : toSave.step;

            if (options.rawRequestResponseHandler) {
                await options.rawRequestResponseHandler(context_, {
                    agentName: options.agentName,
                    request: output.request,
                    response: output.response,
                    threadId,
                    userId,
                });
            }

            if (options.usageHandler && output.usage) {
                await options.usageHandler(context_, {
                    agentName: options.agentName,
                    model: getModelName(activeModel),
                    provider: getProviderName(activeModel),
                    providerMetadata: output.providerMetadata,
                    threadId,
                    usage: output.usage,
                    userId,
                });
            }
        },
        stepOrder: stepOrder ?? 0,
        updateModel: (modelValue: ModelOrMetadata | undefined) => {
            if (modelValue) {
                activeModel = modelValue;
            }
        },
        userId,
    };
};

export default startGeneration;
