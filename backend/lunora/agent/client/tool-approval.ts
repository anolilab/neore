import type { JSONValue } from "@ai-sdk/provider";
import type { Context as AiContext, ToolContent } from "@ai-sdk/provider-utils";
import type { StaticToolError, StaticToolResult, StreamTextResult, Tool, ToolSet } from "ai";

import { createToolModelOutput } from "../shared";
import type { MessageDoc } from "../validators";
import type { ContextAcceptingTool } from "./agent-types";
import type { Agent } from "./index";
import type { StreamingOptions } from "./streaming";
import type { ActionCtx as ActionContext, AgentPrompt, GenerationOutputMetadata, Options, StreamingTextArgs } from "./types";

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
    const { messageId: toolResultId } = await agent.saveMessage(ctx, {
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
