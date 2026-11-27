import type { JSONValue } from "@ai-sdk/provider";
import type { Context as AiContext, ProviderOptions, ToolContent } from "@ai-sdk/provider-utils";
import type { ModelMessage, StaticToolError, StaticToolResult, StreamTextResult, Tool, ToolSet } from "ai";

import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";
import { deleteStoredObjects } from "./object-deletes";
import { serializeStepContent } from "../mapping";
import type { MessageDoc } from "../validators";
import type { ContextAcceptingTool } from "./agent-types";
import type { Agent } from "./index";
import type { StreamingOptions } from "./streaming";
import type { ActionCtx as ActionContext, AgentPrompt, Config, GenerationOutputMetadata, Options, StreamingTextArgs } from "./types";

/**
 * The approval of one tool call as the SDK records it, for the `messages` a tool's `execute` gets when the approval is run
 * here rather than by the SDK: the request names the call, and the response approves it (`chat/lib/purchase-gate.ts#approvedToolCallIds`
 * reads exactly this).
 */
export const approvalMessagesFor = (approvalId: string, toolCallId: string): ModelMessage[] => [
    { content: [{ approvalId, toolCallId, type: "tool-approval-request" }], role: "assistant" },
    { content: [{ approvalId, approved: true, type: "tool-approval-response" }], role: "tool" },
];

/**
 * Delete the files a result's serialization wrote when no saved message came to reference them: the rows and grants
 * (`agent_files.discardUnsavedFiles`, which keeps a file a message counts or another store reused by now), then the storage
 * objects of the rows it took (`deleteStoredObjects`). Each upload has its own key, so that delete never takes the bytes of a
 * store of the same bytes. Never throws — a failed cleanup is logged and its recorded object delete left to the unused-file
 * sweep, so the caller's own error stands.
 */
export const discardUnsavedFiles = async (ctx: ActionContext, fileIds: string[]): Promise<void> => {
    if (fileIds.length === 0) {
        return;
    }

    try {
        const deleteIds = await ctx.runMutation(internal.agent.files.discardUnsavedFiles, { fileIds: fileIds as Id<"chatFiles">[] });

        await deleteStoredObjects(ctx, deleteIds);
    } catch (error) {
        console.error("Failed to discard unsaved tool media:", error);
    }
};

/**
 * Approve a pending tool call and continue generation. The body of
 * {@link Agent.approveToolCall}, which documents the arguments.
 */
export async function approveToolCallFor<CustomContext extends object, AgentTools extends ToolSet>(
    agent: Agent<CustomContext, AgentTools>,
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
    streamTextArgs?: AgentPrompt & StreamingTextArgs<AgentTools>,
    options?: Options & {
        saveStreamDeltas?: boolean | StreamingOptions;
    },
): Promise<GenerationOutputMetadata & StreamTextResult<AgentTools, AiContext, never>> {
    const { approvalId, reason } = approvalArgs;

    const toolInfo = await findToolCallInfo(agent, ctx, threadId, approvalId);

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
    const recheck = await findToolCallInfo(agent, ctx, threadId, approvalId);

    if (recheck && recheck.alreadyHandled) {
        if (recheck.wasApproved) {
            throw new Error(`Tool call was already approved for approval ID: ${approvalId}`);
        }

        throw new Error(`Cannot approve tool call that was already denied for approval ID: ${approvalId}`);
    }

    // Execute the tool
    const { tools } = agent.options;
    const tool = tools?.[toolName] as Tool<any, StaticToolResult<AgentTools> | StaticToolError<AgentTools>>;

    if (!tool) {
        throw new Error(`Tool not found: ${toolName}`);
    }

    // Get thread metadata to propagate userId to tool context if needed
    let resolvedUserId = userId;

    if (!resolvedUserId) {
        ({ userId: resolvedUserId } = await agent.getThreadMetadata(ctx, { threadId }));
    }

    const toolResult: ToolContent = [
        {
            approvalId,
            approved: true,
            reason,
            type: "tool-approval-response" as const,
        },
    ];
    let resultFileIds: string[] | undefined;
    // The files the result's serialization wrote: unreferenced until the save below lands.
    const createdFileIds: string[] = [];

    try {
        // Execute with context injection (like wrapTools does)
        const toolContext = {
            ...ctx,
            agent,
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
        // Only a tool that reads its approval from `messages` (`readsApproval`: the browser's checked clicks) gets the synthetic
        // pair. Any other tool runs with no messages, as before: a saved-login turn validates its messages and refuses the pair.
        const readsApproval = (tool as { readsApproval?: boolean }).readsApproval === true;
        const output = await wrappedTool.execute?.call(wrappedTool, toolInput, {
            context: {},
            messages: readsApproval ? approvalMessagesFor(approvalId, toolCallId) : [],
            toolCallId,
        });

        // Saved as the tool returned it, like a step's result (`serializeStepContent`): the transcript reads the result's
        // own fields (a human check's `run` for its card), and its inline media moves to storage. Each run gives the model
        // the tool's `toModelOutput` of the saved row instead (`withApprovedToolModelOutputs`, below).
        const { messageFileIds, partContent } = await serializeStepContent(
            ctx,
            [{ dynamic: false, input: toolInput, output, toolCallId, toolName, type: "tool-result" }] as never,
            resolvedUserId ? { threadId, userId: resolvedUserId } : undefined,
            createdFileIds,
        );

        toolResult.push(...(partContent as ToolContent).map((part) => (part.type === "tool-result" ? withRawToolResultMark(part) : part)));
        resultFileIds = messageFileIds;
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
        // The error row saved below references none of the media stored before the failure.
        const unreferenced = [...createdFileIds];

        createdFileIds.length = 0;
        await discardUnsavedFiles(ctx, unreferenced);
    }

    // Save approval response and tool result together
    let toolResultId: string;

    try {
        ({ messageId: toolResultId } = await agent.saveMessage(ctx, {
            message: {
                content: toolResult,
                role: "tool",
            },
            ...(resultFileIds && { metadata: { fileIds: resultFileIds } }),
            promptMessageId: parentMessageId,
            skipEmbeddings: true,
            threadId,
        }));
    } catch (error) {
        // No saved row references the media this result stored: take it back, and fail with the save's own error.
        await discardUnsavedFiles(ctx, createdFileIds);

        throw error;
    }

    // Continue generation with forceNewOrder to create a separate message.
    //
    // The cast below is the one thing here worth explaining. `streamText`
    // returns `StreamTextResult<TOOLS extends undefined ? AgentTools : TOOLS, …>`;
    // instantiating TOOLS as `AgentTools` leaves a DEFERRED conditional,
    // because TypeScript will not reduce `T extends undefined ? A : A` while
    // `T` is an unbound class parameter. So the result is provably the declared
    // type and is not assignable to it. Dropping the explicit generic does not
    // help either — TOOLS is then inferred from `streamTextArgs.tools`.
    return (await agent.streamText<AgentTools>(
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
 * Deny a pending tool call and continue generation. The body of
 * {@link Agent.denyToolCall}, which documents the arguments.
 */
export async function denyToolCallFor<CustomContext extends object, AgentTools extends ToolSet>(
    agent: Agent<CustomContext, AgentTools>,
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

    const toolInfo = await findToolCallInfo(agent, ctx, threadId, approvalId);

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
    const { messageId: toolResultId } = await agent.saveMessage(ctx, {
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
    return agent.streamText(
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
async function findToolCallInfo<CustomContext extends object, AgentTools extends ToolSet>(
    agent: Agent<CustomContext, AgentTools>,
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
    const allMessages: MessageDoc[] = [];
    let cursor: string | null = null;
    const PAGE_SIZE = 100;
    const MAX_MESSAGES = 5000;

    while (allMessages.length < MAX_MESSAGES) {
        const messagesResult = await agent.listMessages(context, {
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

/**
 * Marks a result an approval saved as the tool returned it (`providerOptions.neore.rawToolResult`). A row approved before
 * results were saved raw holds the tool's model output already: it carries no mark and reaches the model as saved, never
 * converted a second time.
 */
const withRawToolResultMark = <Part extends { providerOptions?: ProviderOptions }>(part: Part): Part => {
    return { ...part, providerOptions: { ...part.providerOptions, neore: { ...part.providerOptions?.neore, rawToolResult: true } } };
};

const hasRawToolResultMark = (part: { providerOptions?: unknown }): boolean =>
    (part.providerOptions as { neore?: { rawToolResult?: unknown } } | undefined)?.neore?.rawToolResult === true;

/**
 * The tool calls whose saved result an approval ran (`approveToolCallFor`): a `tool` row holding an approved
 * `tool-approval-response` and the result saved raw (marked by `withRawToolResultMark`). Read from the stored rows, since a
 * model message carries no approval part.
 */
export const approvedToolCallIdsOf = (messages: ReadonlyArray<ModelMessage | MessageDoc["message"]>): Set<string> => {
    const ids = new Set<string>();

    for (const message of messages) {
        if (message?.role !== "tool" || !Array.isArray(message.content)) {
            continue;
        }

        const parts = message.content as { approved?: boolean; providerOptions?: unknown; toolCallId?: string; type: string }[];

        if (parts.every((part) => !(part.type === "tool-approval-response" && part.approved === true))) {
            continue;
        }

        for (const part of parts) {
            if (part.type === "tool-result" && part.toolCallId && hasRawToolResultMark(part)) {
                ids.add(part.toolCallId);
            }
        }
    }

    return ids;
};

/**
 * `messages` with each approved call's saved result given to the model through its tool's `toModelOutput`, as a step's
 * own result is: the row keeps what the tool returned (the transcript reads it), the model gets the tool's view of it.
 * A result whose tool is neither in the run nor found by `builtInToolFormatter`, has no `toModelOutput`, or is an error
 * stays as saved.
 */
export const withApprovedToolModelOutputs = async (
    messages: ModelMessage[],
    tools: ToolSet,
    approvedIds: ReadonlySet<string>,
    builtInToolFormatter?: Config["builtInToolFormatter"],
): Promise<ModelMessage[]> => {
    if (approvedIds.size === 0) {
        return messages;
    }

    return await Promise.all(
        messages.map(async (message) => {
            if (message.role !== "tool") {
                return message;
            }

            let changed = false;
            const content = await Promise.all(
                message.content.map(async (part) => {
                    if (part.type !== "tool-result" || !approvedIds.has(part.toolCallId) || (part.output.type !== "json" && part.output.type !== "text")) {
                        return part;
                    }

                    // The run's own tool, else the built-in of that name: never only the run's, as a call that offers
                    // no tools (a cap's wrap-up) or a tool switched off since must still show the model the tool's view.
                    const offered = tools[part.toolName] as Tool | undefined;
                    const tool = offered?.toModelOutput ? offered : await builtInToolFormatter?.(part.toolName);

                    if (!tool?.toModelOutput) {
                        return part;
                    }

                    try {
                        const output = await tool.toModelOutput.call(tool, {
                            input: (part as { input?: unknown }).input,
                            output: part.output.value,
                            toolCallId: part.toolCallId,
                        });

                        changed = true;

                        return { ...part, output };
                    } catch (error) {
                        console.error("[withApprovedToolModelOutputs] toModelOutput failed; the saved result is sent", {
                            error: error instanceof Error ? error.message : String(error),
                            toolName: part.toolName,
                        });

                        return part;
                    }
                }),
            );

            return changed ? ({ ...message, content } as ModelMessage) : message;
        }),
    );
};
