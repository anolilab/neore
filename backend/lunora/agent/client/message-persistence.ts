import type { ModelMessage, GenerateObjectResult, StepResult, ToolSet } from "ai";

import { internal } from "../../_generated/internal";
import { serializeMessage, serializeNewMessagesInStep, serializeObjectResult } from "../mapping";
import { getModelName, getProviderName } from "../shared";
import type { Message, MessageDoc, MessageWithMetadata, MessageWithMetadataInternal } from "../validators";
import type { WritableAgentContext } from "./agent-types";
import type { Agent } from "./index";
import { type SaveMessagesArgs, saveMessages } from "./messages";
import { generateAndSaveEmbeddings } from "./search";
import type { ActionCtx as ActionContext } from "./types";
import { asId, asIdArray, asOptionalIdArray } from "./utilities";

/**
 * The body of {@link Agent.saveMessages}, which documents the arguments.
 */
export async function saveMessagesFor<CustomContext extends object, AgentTools extends ToolSet>(
    agent: Agent<CustomContext, AgentTools>,
    ctx: WritableAgentContext,
    args: SaveMessagesArgs & {
        skipEmbeddings?: boolean;
    },
): Promise<{ messages: MessageDoc[] }> {
    let embeddings: { model: string; vectors: (number[] | null)[] } | undefined;
    const { skipEmbeddings, ...rest } = args;

    if (args.embeddings) {
        embeddings = args.embeddings;
    } else if (!skipEmbeddings && agent.options.embeddingModel) {
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
            embeddings = await agent.generateEmbeddings(ctx, { threadId: args.threadId, userId: args.userId ?? undefined }, args.messages);
        }
    }

    return saveMessages(ctx, {
        ...rest,
        agentName: agent.options.name,
        embeddings,
    });
}

/**
 * The body of {@link Agent.generateAndSaveEmbeddings}, which documents the arguments.
 */
export async function generateAndSaveEmbeddingsFor<CustomContext extends object, AgentTools extends ToolSet>(
    agent: Agent<CustomContext, AgentTools>,
    ctx: ActionContext,
    args: { messageIds: string[] },
) {
    // Raw rows: embeddings are stored with their thread's id and search already filters locked threads.
    const fetched = await ctx.runQuery(internal.agent.messages.getMessagesByIdsUnfiltered, {
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

    const { embeddingModel } = agent.options;

    if (!embeddingModel) {
        throw new Error("No embeddings were generated for the messages. You must pass an embeddingModel to the agent constructor.");
    }

    const firstMessage = messages[0];

    if (!firstMessage) {
        throw new Error("No messages to generate embeddings for");
    }

    await generateAndSaveEmbeddings(
        ctx,
        agent.component,
        {
            ...agent.options,
            agentName: agent.options.name,
            embeddingModel,
            threadId: firstMessage.threadId,
            userId: firstMessage.userId,
        },
        messages,
    );
}

/**
 * The body of {@link Agent.saveStep}, which documents the arguments.
 */
export async function saveStepFor<CustomContext extends object, AgentTools extends ToolSet, TOOLS extends ToolSet>(
    agent: Agent<CustomContext, AgentTools>,
    ctx: ActionContext,
    args: {
        model?: string;
        promptMessageId: string;
        provider?: string;
        step: StepResult<TOOLS>;
        threadId: string;
        userId?: string;
    },
): Promise<{ messages: MessageDoc[] }> {
    const { messages } = await serializeNewMessagesInStep(ctx, args.step, {
        model: args.model ?? getModelName(agent.options.languageModel),
        provider: args.provider ?? getProviderName(agent.options.languageModel),
    });
    const embeddings = await agent.generateEmbeddings(
        ctx,
        { threadId: args.threadId, userId: args.userId },
        messages.map((m) => m.message),
    );

    return ctx.runMutation(internal.agent.messages.addMessages, {
        agentName: agent.options.name,
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
 * The body of {@link Agent.saveObject}, which documents the arguments.
 */
export async function saveObjectFor<CustomContext extends object, AgentTools extends ToolSet>(
    agent: Agent<CustomContext, AgentTools>,
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
        model: args.model ?? args.metadata?.model ?? getModelName(agent.options.languageModel),
        provider: args.provider ?? args.metadata?.provider ?? getProviderName(agent.options.languageModel),
    });
    const embeddings = await agent.generateEmbeddings(
        ctx,
        { threadId: args.threadId, userId: args.userId },
        messages.map((m) => m.message),
    );

    return ctx.runMutation(internal.agent.messages.addMessages, {
        agentName: agent.options.name,
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
 * The body of {@link Agent.updateMessage}, which documents the arguments.
 */
export async function updateMessageFor(
    ctx: WritableAgentContext,
    args: {
        messageId: string;
        patch: {
            error?: string;
            fileIds?: string[];
            message: ModelMessage | Message;
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
