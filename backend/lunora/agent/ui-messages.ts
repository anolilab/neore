import type { ProviderMetadata } from "ai";
import {
    convertToModelMessages,
    type DeepPartial,
    type DynamicToolUIPart,
    type ReasoningUIPart,
    type SourceDocumentUIPart,
    type SourceUrlUIPart,
    type StepStartUIPart,
    type TextUIPart,
    type ToolResultPart,
    type ToolUIPart,
    type UIDataTypes,
    type UIMessage as AIUIMessage,
    type UITools,
} from "ai";
import type { Infer } from "lunorash/server";

import { omit, pick } from "../lib/collections";
import type { MessageBranch } from "./branch-tree";
import { fromModelMessage, toModelMessage, toUIFilePart } from "./mapping";
import { type MessageCost, type StepUsage, sumMessageCosts, sumStepUsage } from "./message-cost";
import { extractReasoning, extractText, isTool, joinText, sorted } from "./shared";
import type { MessageDoc, MessageStatus, ProviderOptions, SourcePart, vSource } from "./validators";

/**
 * The approval envelope this module attaches to a `ToolUIPart`.
 *
 * `id` is the only field an approval REQUEST carries; a response adds
 * `approved` and, when the user gave one, `reason`.
 */
interface ToolApproval {
    approved?: boolean;
    id: string;
    reason?: string;
}

export type UIStatus = "streaming" | MessageStatus;

export type { MessageBranch } from "./branch-tree";
export type { MessageCost } from "./message-cost";

export type MessageUsage = {
    cachedInputTokens?: number;
    completionTokens: number;
    durationMs?: number;
    promptTokens: number;
    reasoningTokens?: number;
    totalTokens: number;
    ttftMs?: number;
};

export type UIMessage<METADATA = unknown, DATA_PARTS extends UIDataTypes = UIDataTypes, TOOLS extends UITools = UITools> = {
    _creationTime: number;
    agentName?: string;
    /** Set when this message has alternatives (regenerated / edited) — see `branch-tree.ts`. */
    branch?: MessageBranch;
    /** Gateway cost of the whole assistant turn, summed across its steps. */
    cost?: MessageCost;
    error?: string;
    key: string;
    /**
     * Set when memories were injected into this reply's prompt: how many, and the
     * row that records them (`memory_functions.getMessageMemoryUsage` takes its id).
     */
    memoryUsage?: { count: number; messageId: string };
    model?: string;
    order: number;
    /** Group chat: the participant (skill id) that wrote this reply; `agentName` is its name. */
    speakerSkillId?: string;
    status: UIStatus;
    stepOrder: number;
    text: string;
    usage?: MessageUsage;
    userId?: string;
} & AIUIMessage<METADATA, DATA_PARTS, TOOLS>;

/**
 * Converts a list of UIMessages to MessageDocs, along with extra metadata that
 * may be available to associate with the MessageDocs.
 * @param messages The UIMessages to convert to MessageDocs.
 * @param meta The metadata to add to the MessageDocs.
 * @returns
 */
export const fromUIMessages = async <METADATA = unknown>(
    messages: UIMessage<METADATA>[],
    meta: {
        metadata?: METADATA;
        model?: string;
        provider?: string;
        providerOptions?: ProviderOptions;
        threadId: string;
        userId?: string;
    },
): Promise<(MessageDoc & { metadata?: METADATA; streaming: boolean })[]> => {
    const nested = await Promise.all(
        messages.map(async (uiMessage) => {
            const { stepOrder } = uiMessage;
            const commonFields = {
                ...pick(meta, ["threadId", "userId", "model", "provider", "providerOptions", "metadata"]),
                ...omit(uiMessage, ["parts", "role", "key", "text", "userId"]),
                // to override
                _id: uiMessage.id,
                status: uiMessage.status === "streaming" ? "pending" : "success",
                streaming: uiMessage.status === "streaming",
                tool: false,
                userId: uiMessage.userId ?? meta.userId,
            } satisfies MessageDoc & { metadata?: METADATA; streaming: boolean };
            const modelMessages = await convertToModelMessages([uiMessage]);

            return modelMessages
                .map((modelMessage, i) => {
                    if (modelMessage.content.length === 0) {
                        return undefined;
                    }

                    const message = fromModelMessage(modelMessage);
                    const tool = isTool(message);
                    const documentRow: MessageDoc & { metadata?: METADATA; streaming: boolean } = {
                        ...commonFields,
                        _id: `${uiMessage.id}-${i}`,
                        finishReason: tool ? "tool-calls" : "stop",
                        message,
                        reasoning: extractReasoning(message),
                        sources: fromSourceParts(uiMessage.parts),
                        stepOrder: stepOrder + i,
                        text: extractText(message),
                        tool,
                    };

                    if (Array.isArray(modelMessage.content)) {
                        // Find a content part with providerOptions (type assertion needed for SDK compatibility)
                        const partWithProviderOptions = modelMessage.content.find(
                            (c): c is typeof c & { providerOptions: unknown } => "providerOptions" in c && c.providerOptions !== undefined,
                        );

                        if (partWithProviderOptions?.providerOptions) {
                            // convertToModelMessages changes providerMetadata to providerOptions
                            const providerOptions = partWithProviderOptions.providerOptions as ProviderMetadata | undefined;

                            if (providerOptions) {
                                documentRow.providerMetadata = providerOptions;
                                documentRow.providerOptions ??= providerOptions;
                            }
                        }
                    }

                    return documentRow;
                })
                .filter((d) => d !== undefined);
        }),
    );

    return nested.flat();
};

const fromSourceParts = (parts: UIMessage["parts"]): Infer<typeof vSource>[] =>
    parts
        .map((part) => {
            if (part.type === "source-url") {
                return {
                    id: part.sourceId,
                    providerMetadata: part.providerMetadata,
                    sourceType: "url",
                    title: part.title,
                    type: "source",
                    url: part.url,
                } satisfies Infer<typeof vSource>;
            }

            if (part.type === "source-document") {
                return {
                    id: part.sourceId,
                    mediaType: part.mediaType,
                    providerMetadata: part.providerMetadata,
                    sourceType: "document",
                    title: part.title,
                    type: "source",
                } satisfies Infer<typeof vSource>;
            }

            return undefined;
        })
        .filter((p) => p !== undefined);

type ExtraFields<METADATA = unknown> = {
    metadata?: METADATA;
    streaming?: boolean;
};

/**
 * Converts a list of MessageDocs to UIMessages.
 * This is somewhat lossy, as many fields are not supported by UIMessages, e.g.
 * the model, provider, userId, etc.
 * The UIMessage type is the augmented type that includes more fields such as
 * key, order, stepOrder, status, agentName, text, etc.
 */
export const toUIMessages = <METADATA = unknown, DATA_PARTS extends UIDataTypes = UIDataTypes, TOOLS extends UITools = UITools>(
    messages: (ExtraFields<METADATA> & MessageDoc)[],
): UIMessage<METADATA, DATA_PARTS, TOOLS>[] => {
    // Group assistant and tool messages together
    const assistantGroups = groupAssistantMessages(sorted(messages));

    const uiMessages: UIMessage<METADATA, DATA_PARTS, TOOLS>[] = [];

    for (const group of assistantGroups) {
        if (group.role === "system") {
            uiMessages.push(createSystemUIMessage(group.message));
        } else if (group.role === "user") {
            uiMessages.push(createUserUIMessage(group.message));
        } else {
            // Assistant/tool group
            uiMessages.push(createAssistantUIMessage(group.messages));
        }
    }

    return uiMessages;
};

type Group<METADATA = unknown> =
    | {
          message: ExtraFields<METADATA> & MessageDoc;
          role: "user";
      }
    | {
          message: ExtraFields<METADATA> & MessageDoc;
          role: "system";
      }
    | {
          messages: (ExtraFields<METADATA> & MessageDoc)[];
          role: "assistant";
      };

const groupAssistantMessages = <METADATA = unknown>(messages: (ExtraFields<METADATA> & MessageDoc)[]): Group<METADATA>[] => {
    const groups: Group<METADATA>[] = [];

    let currentAssistantGroup: (ExtraFields<METADATA> & MessageDoc)[] = [];
    let currentOrder: number | undefined;

    for (const message of messages) {
        const coreMessage = message.message && toModelMessage(message.message);

        // Don't skip failed messages without content - they should still be displayed
        if (!coreMessage && message.status !== "failed") {
            continue;
        }

        // Determine the role - use coreMessage.role if available, otherwise treat as assistant (for failed messages)
        const role = coreMessage?.role ?? "assistant";

        if (role === "user" || role === "system") {
            // Finish any current assistant group
            if (currentAssistantGroup.length > 0) {
                groups.push({
                    messages: currentAssistantGroup,
                    role: "assistant",
                });
                currentAssistantGroup = [];
                currentOrder = undefined;
            }

            // Add singleton group
            groups.push({
                message,
                role,
            });
        } else {
            // Assistant or tool message.
            //
            // Group solely by `order` value. All non-user messages within the same
            // conversation turn share the same `order` (only user messages increment it).
            // This means pre-tool text, tool-call, tool-result, and post-tool text all
            // belong together in one UIMessage, rendered as one connected response.
            //
            // The group closes only when the order changes (next turn) or a user/system
            // message is encountered above — not when a non-tool assistant message ends
            // a step, which would split multi-step tool-use into broken fragments.
            if (currentOrder !== undefined && message.order !== currentOrder && currentAssistantGroup.length > 0) {
                groups.push({
                    messages: currentAssistantGroup,
                    role: "assistant",
                });
                currentAssistantGroup = [];
            }

            currentOrder = message.order;
            currentAssistantGroup.push(message);
        }
    }

    // Add any remaining assistant group
    if (currentAssistantGroup.length > 0) {
        groups.push({
            messages: currentAssistantGroup,
            role: "assistant",
        });
    }

    return groups;
};

const createSystemUIMessage = <METADATA = unknown, DATA_PARTS extends UIDataTypes = UIDataTypes, TOOLS extends UITools = UITools>(
    message: ExtraFields<METADATA> & MessageDoc,
): UIMessage<METADATA, DATA_PARTS, TOOLS> => {
    const text = extractTextFromMessageDocument(message);
    const partCommon = {
        state: message.streaming ? ("streaming" as const) : ("done" as const),
        // `providerMetadata` is stored as opaque JSON, so the column type is
        // `Record<string, Record<string, unknown>>`. The AI SDK wants
        // `ProviderMetadata` — the same shape with `JSONValue` leaves, and
        // `unknown` is not assignable to `JSONValue`. This is the storage/SDK
        // boundary; the cast belongs here rather than at each of the eight part
        // constructors below.
        ...(message.providerMetadata && { providerMetadata: message.providerMetadata as ProviderMetadata }),
    };

    return {
        _creationTime: message._creationTime,
        agentName: message.agentName,
        id: message._id,
        key: `${message.threadId}-${message.order}-${message.stepOrder}`,
        metadata: message.metadata,
        order: message.order,
        parts: [{ text, type: "text", ...partCommon } satisfies TextUIPart],
        role: "system",
        status: message.streaming ? ("streaming" as const) : message.status,
        stepOrder: message.stepOrder,
        text,
        userId: message.userId,
        ...(message.error && { error: message.error }),
        ...(message.model && { model: message.model }),
    };
};

const extractTextFromMessageDocument = (message: MessageDoc): string => (message.message && extractText(message.message)) || message.text || "";

const createUserUIMessage = <METADATA = unknown, DATA_PARTS extends UIDataTypes = UIDataTypes, TOOLS extends UITools = UITools>(
    message: ExtraFields<METADATA> & MessageDoc,
): UIMessage<METADATA, DATA_PARTS, TOOLS> => {
    const text = extractTextFromMessageDocument(message);
    const coreMessage = toModelMessage(message.message!);
    const { content } = coreMessage;
    const nonStringContent = content && typeof content !== "string" ? content : [];

    const partCommon = {
        state: message.streaming ? ("streaming" as const) : ("done" as const),
        // `providerMetadata` is stored as opaque JSON, so the column type is
        // `Record<string, Record<string, unknown>>`. The AI SDK wants
        // `ProviderMetadata` — the same shape with `JSONValue` leaves, and
        // `unknown` is not assignable to `JSONValue`. This is the storage/SDK
        // boundary; the cast belongs here rather than at each of the eight part
        // constructors below.
        ...(message.providerMetadata && { providerMetadata: message.providerMetadata as ProviderMetadata }),
    };

    const parts: UIMessage<METADATA, DATA_PARTS, TOOLS>["parts"] = [];

    if (text && nonStringContent.length === 0) {
        parts.push({ text, type: "text" });
    }

    for (const contentPart of nonStringContent) {
        switch (contentPart.type) {
            case "file":
            case "image": {
                parts.push(toUIFilePart(contentPart));
                break;
            }
            case "text": {
                // A part's own `providerOptions` becomes the UI part's
                // `providerMetadata` (the SDK's name for it on the UI side). It is
                // how a page-context part is recognised (`chat/lib/page-context.ts`).
                parts.push({
                    text: contentPart.text,
                    type: "text",
                    ...partCommon,
                    ...(contentPart.providerOptions && { providerMetadata: contentPart.providerOptions as ProviderMetadata }),
                });
                break;
            }
            default: {
                console.warn("Unknown content part type for user", contentPart);
                break;
            }
        }
    }

    return {
        _creationTime: message._creationTime,
        id: message._id,
        key: `${message.threadId}-${message.order}-${message.stepOrder}`,
        metadata: message.metadata,
        order: message.order,
        parts,
        role: "user",
        status: message.streaming ? ("streaming" as const) : message.status,
        stepOrder: message.stepOrder,
        text,
        userId: message.userId,
        ...(message.error && { error: message.error }),
        ...(message.model && { model: message.model }),
    };
};

/** The group's row that recorded injected memories (its first, normally), as the UI message's `memoryUsage`. */
const memoryUsageOf = (group: ReadonlyArray<MessageDoc>): { memoryUsage?: { count: number; messageId: string } } => {
    const row = group.find((m) => (m.retrievedMemories?.length ?? 0) > 0);

    return row ? { memoryUsage: { count: row.retrievedMemories!.length, messageId: row._id } } : {};
};

const createAssistantUIMessage = <METADATA = unknown, DATA_PARTS extends UIDataTypes = UIDataTypes, TOOLS extends UITools = UITools>(
    groupUnordered: (ExtraFields<METADATA> & MessageDoc)[],
): UIMessage<METADATA, DATA_PARTS, TOOLS> => {
    const group = sorted(groupUnordered);
    const firstMessage = group[0];
    const lastMessage = group.at(-1);

    if (!firstMessage || !lastMessage) {
        throw new Error("createAssistantUIMessage requires at least one message");
    }

    // Use first message for special fields
    const common = {
        _creationTime: firstMessage._creationTime,
        agentName: firstMessage.agentName,
        id: firstMessage._id,
        key: `${firstMessage.threadId}-${firstMessage.order}-${firstMessage.stepOrder}`,
        order: firstMessage.order,
        ...(firstMessage.speakerSkillId && { speakerSkillId: firstMessage.speakerSkillId }),
        ...memoryUsageOf(group),
        stepOrder: firstMessage.stepOrder,
        userId: firstMessage.userId,
    };

    // Get status from last message
    const status = lastMessage.streaming ? ("streaming" as const) : lastMessage.status;

    // Collect all parts from all messages
    const allParts: UIMessage<METADATA, DATA_PARTS, TOOLS>["parts"] = [];

    /**
     * A tool RESULT that arrived with no preceding tool CALL in the same group.
     *
     * Two facts about this branch cannot be proved to the compiler, and both
     * follow from the call part being absent:
     *
     * - `toolName` is a string read back from storage. `ToolUIPart<TOOLS>`
     *   discriminates on `tool-${keyof TOOLS}`, and a stored message may name a
     *   tool that has since been removed from the registry — there is no proof
     *   to be had.
     * - ai@7 made `input` required on `output-denied` and `output-available`
     *   (it was optional before). The input lived on the call part, which is the
     *   one that is missing; `undefined` is the honest value and the renderer
     *   already treats it as "input unknown".
     *
     * The state/payload pairing — the part that CAN go wrong by hand — stays
     * checked, because `result` is a discriminated union parameter.
     */
    const orphanToolResultPart = (
        toolName: string,
        toolCallId: string,
        callProviderMetadata: ProviderMetadata | undefined,
        result:
            | { approval: { approved: false; id: string; reason: string | undefined }; state: "output-denied" }
            | { errorText: string; state: "output-error" }
            | { output: unknown; state: "output-available" },
    ): ToolUIPart<TOOLS> =>
        ({
            callProviderMetadata,
            input: undefined,
            toolCallId,
            type: `tool-${toolName}`,
            ...result,
        }) as ToolUIPart<TOOLS>;

    for (const message of group) {
        const coreMessage = message.message && toModelMessage(message.message);

        if (!coreMessage) {
            continue;
        }

        const { content } = coreMessage;
        const nonStringContent = content && typeof content !== "string" ? content : [];
        // Keep reference to raw content to check for execution-denied before normalization
        const rawContent = message.message?.content;
        const text = extractTextFromMessageDocument(message);

        const partCommon = {
            state: message.streaming ? ("streaming" as const) : ("done" as const),
            // See the note on the other two `partCommon` blocks — storage/SDK boundary.
            ...(message.providerMetadata && { providerMetadata: message.providerMetadata as ProviderMetadata }),
        };

        // Add reasoning parts
        if (message.reasoning && nonStringContent.every((c) => c.type !== "reasoning")) {
            allParts.push({
                text: message.reasoning,
                type: "reasoning",
                ...partCommon,
            } satisfies ReasoningUIPart);
        }

        // Add text parts if no structured content
        if (text && nonStringContent.length === 0) {
            allParts.push({
                text,
                type: "text",
                ...partCommon,
            } satisfies TextUIPart);
        }

        // Add all structured content parts
        for (const contentPart of nonStringContent) {
            switch (contentPart.type) {
                case "file":
                case "image": {
                    allParts.push(toUIFilePart(contentPart));
                    break;
                }
                case "reasoning": {
                    allParts.push({
                        ...partCommon,
                        ...contentPart,
                    } satisfies ReasoningUIPart);
                    break;
                }
                case "text": {
                    allParts.push({
                        ...partCommon,
                        ...contentPart,
                    } satisfies TextUIPart);
                    break;
                }
                case "tool-approval-request": {
                    // Find the matching tool call
                    const typedPart = contentPart as {
                        approvalId: string;
                        toolCallId: string;
                    };
                    const toolCallPart = allParts.find((part) => "toolCallId" in part && part.toolCallId === typedPart.toolCallId) as ToolUIPart | undefined;

                    if (toolCallPart) {
                        toolCallPart.state = "approval-requested";
                        (toolCallPart as ToolUIPart & { approval?: ToolApproval }).approval = {
                            id: typedPart.approvalId,
                        };
                    } else {
                        console.warn("Tool approval request without preceding tool call", contentPart);
                    }

                    break;
                }
                case "tool-approval-response": {
                    // Find the tool call that has this approval by matching approval.id
                    const typedPart = contentPart as {
                        approvalId: string;
                        approved: boolean;
                        reason?: string;
                    };
                    const toolCallPart = allParts.find(
                        (part) => "approval" in part && (part as ToolUIPart & { approval?: { id: string } }).approval?.id === typedPart.approvalId,
                    ) as ToolUIPart | undefined;

                    if (toolCallPart) {
                        if (typedPart.approved) {
                            toolCallPart.state = "approval-responded";
                            (toolCallPart as ToolUIPart & { approval?: ToolApproval }).approval = {
                                approved: true,
                                id: typedPart.approvalId,
                                reason: typedPart.reason,
                            };
                        } else {
                            toolCallPart.state = "output-denied";
                            (toolCallPart as ToolUIPart & { approval?: ToolApproval }).approval = {
                                approved: false,
                                id: typedPart.approvalId,
                                reason: typedPart.reason,
                            };
                        }
                    } else {
                        console.warn("Tool approval response without matching approval request", contentPart);
                    }

                    break;
                }
                case "tool-call": {
                    allParts.push({
                        type: "step-start",
                    } satisfies StepStartUIPart);
                    // Each state is built whole rather than spread onto a shared
                    // base. `ToolUIPart` is a discriminated union, and a
                    // conditional spread widens `state` to the union of both
                    // literals before the discriminant is ever read — so the
                    // result matches no member. ai@7 narrowed the per-state
                    // payloads (`input` is `DeepPartial` only while streaming),
                    // which is what surfaced this.
                    const toolName = contentPart.toolName as keyof TOOLS & string;
                    const toolPart: ToolUIPart<TOOLS> = message.streaming
                        ? {
                              input: contentPart.input as DeepPartial<TOOLS[keyof TOOLS & string]["input"]>,
                              providerExecuted: contentPart.providerExecuted,
                              state: "input-streaming",
                              toolCallId: contentPart.toolCallId,
                              type: `tool-${toolName}`,
                          }
                        : {
                              // A stamped MCP call's real server/tool names
                              // (`chat/lib/mcp-tool-labels.ts`) ride alongside the step's metadata.
                              callProviderMetadata: withNeoreLabel(message.providerMetadata as ProviderMetadata | undefined, contentPart.providerOptions),
                              input: contentPart.input as TOOLS[keyof TOOLS & string]["input"],
                              providerExecuted: contentPart.providerExecuted,
                              state: "input-available",
                              toolCallId: contentPart.toolCallId,
                              type: `tool-${toolName}`,
                          };

                    allParts.push(toolPart);
                    break;
                }
                case "tool-result": {
                    const typedPart = contentPart as unknown as ToolResultPart & {
                        output: { reason?: string; type: string; value?: unknown };
                    };

                    // Check if this is an execution-denied result
                    // We need to check the raw content because normalizeToolResult converts execution-denied to text
                    type RawToolResult = { isError?: boolean; output?: { reason?: string; type: string }; toolCallId: string; type: string };
                    const rawToolResult = Array.isArray(rawContent)
                        ? (rawContent.find((p) => p?.type === "tool-result" && (p as RawToolResult)?.toolCallId === contentPart.toolCallId) as
                              RawToolResult | undefined)
                        : undefined;
                    const isExecutionDenied = typedPart.output?.type === "execution-denied" || rawToolResult?.output?.type === "execution-denied";

                    if (isExecutionDenied) {
                        const denialReason = typedPart.output?.type === "execution-denied" ? typedPart.output.reason : rawToolResult?.output?.reason;
                        const call = allParts.find(
                            (part) => part.type === `tool-${contentPart.toolName}` && "toolCallId" in part && part.toolCallId === contentPart.toolCallId,
                        ) as ToolUIPart | undefined;

                        if (call) {
                            call.state = "output-denied";

                            if (!("approval" in call) || !call.approval) {
                                (call as ToolUIPart & { approval?: ToolApproval }).approval = {
                                    approved: false,
                                    id: "",
                                    reason: denialReason,
                                };
                            } else {
                                const { approval } = call as ToolUIPart & {
                                    approval: { approved?: boolean; reason?: string };
                                };

                                approval.approved = false;
                                approval.reason = denialReason;
                            }
                        } else {
                            // No preceding tool call, add a tool part with output-denied state
                            allParts.push(
                                orphanToolResultPart(contentPart.toolName, contentPart.toolCallId, message.providerMetadata as ProviderMetadata | undefined, {
                                    approval: { approved: false, id: "", reason: denialReason },
                                    state: "output-denied",
                                }),
                            );
                        }

                        break;
                    }

                    const output = typeof typedPart.output?.type === "string" ? typedPart.output.value : typedPart.output;
                    // Check for error at both the content part level (isError) and message level
                    // isError may exist on stored tool results but isn't in ToolResultPart type
                    // Also check raw content since isError is lost during toModelMessage conversion
                    const hasError =
                        (contentPart as { isError?: boolean }).isError || (rawToolResult as { isError?: boolean } | undefined)?.isError || message.error;
                    const errorText = message.error || (hasError ? String(output) : undefined);
                    const call = allParts.find(
                        (part) => part.type === `tool-${contentPart.toolName}` && "toolCallId" in part && part.toolCallId === contentPart.toolCallId,
                    ) as ToolUIPart | undefined;

                    if (call) {
                        if (hasError) {
                            call.state = "output-error";
                            call.errorText = errorText ?? "Unknown error";
                        } else {
                            call.state = "output-available";
                        }

                        call.output = output;
                    } else {
                        console.warn("Tool result without preceding tool call.. adding anyways", contentPart);

                        if (hasError) {
                            allParts.push(
                                orphanToolResultPart(contentPart.toolName, contentPart.toolCallId, message.providerMetadata as ProviderMetadata | undefined, {
                                    errorText: errorText ?? "Unknown error",
                                    state: "output-error",
                                }),
                            );
                        } else {
                            allParts.push(
                                orphanToolResultPart(contentPart.toolName, contentPart.toolCallId, message.providerMetadata as ProviderMetadata | undefined, {
                                    output,
                                    state: "output-available",
                                }),
                            );
                        }
                    }

                    break;
                }
                default: {
                    const maybeSource = contentPart as unknown as SourcePart;

                    if (maybeSource.type === "source") {
                        allParts.push(toSourcePart(maybeSource));
                    } else {
                        console.warn("Unknown content part type for assistant", contentPart);
                    }
                }
            }
        }

        // Add source parts
        const sources = message.sources ?? [];

        for (const source of sources) {
            allParts.push(toSourcePart(source));
        }

        // Process approval parts from raw content (they are filtered out by toModelMessageContent)
        if (Array.isArray(rawContent)) {
            for (const rawPart of rawContent) {
                if (rawPart?.type === "tool-approval-request") {
                    const typedPart = rawPart as {
                        approvalId: string;
                        toolCallId: string;
                    };
                    const toolCallPart = allParts.find((part) => "toolCallId" in part && part.toolCallId === typedPart.toolCallId) as ToolUIPart | undefined;

                    if (toolCallPart) {
                        toolCallPart.state = "approval-requested";
                        (toolCallPart as ToolUIPart & { approval?: ToolApproval }).approval = {
                            id: typedPart.approvalId,
                        };
                    }
                } else if (rawPart?.type === "tool-approval-response") {
                    const typedPart = rawPart as {
                        approvalId: string;
                        approved: boolean;
                        reason?: string;
                    };
                    const toolCallPart = allParts.find(
                        (part) => "approval" in part && (part as ToolUIPart & { approval?: { id: string } }).approval?.id === typedPart.approvalId,
                    ) as ToolUIPart | undefined;

                    if (toolCallPart) {
                        // Don't override output states - if tool result already set output-available/error/denied, keep that
                        const hasOutput = ["output-available", "output-denied", "output-error"].includes(toolCallPart.state);

                        if (typedPart.approved) {
                            // Only set to approval-responded if no output state has been set yet
                            if (!hasOutput) {
                                toolCallPart.state = "approval-responded";
                            }

                            (toolCallPart as ToolUIPart & { approval?: ToolApproval }).approval = {
                                approved: true,
                                id: typedPart.approvalId,
                                reason: typedPart.reason,
                            };
                        } else {
                            toolCallPart.state = "output-denied";
                            (toolCallPart as ToolUIPart & { approval?: ToolApproval }).approval = {
                                approved: false,
                                id: typedPart.approvalId,
                                reason: typedPart.reason,
                            };
                        }
                    }
                }
            }
        }
    }

    // Get error from last message (if failed)
    const { error, model } = lastMessage;

    // Summed over every step, tool-calling ones included, so tokens describe the
    // same model calls the summed cost does.
    const usage: MessageUsage | undefined = sumStepUsage(group.map((m) => m.usage as StepUsage | undefined));
    // Every step, tool-calling ones included: each was a billed model call. Tool-RESULT
    // rows carry no `providerMetadata`, so they add nothing.
    const cost = sumMessageCosts(group.map((m) => m.providerMetadata));

    return {
        ...common,
        metadata: group.find((m) => m.metadata)?.metadata,
        parts: allParts,
        role: "assistant",
        status,
        text: joinText(allParts),
        ...(error && { error }),
        ...(model && { model }),
        ...(usage && { usage }),
        ...(cost && { cost }),
    };
};

const toSourcePart = (part: SourcePart | Infer<typeof vSource>): SourceUrlUIPart | SourceDocumentUIPart => {
    if (part.sourceType === "url") {
        return {
            // Storage/SDK boundary, same as the `partCommon` blocks above.
            providerMetadata: part.providerMetadata as ProviderMetadata | undefined,
            sourceId: part.id,
            title: part.title,
            type: "source-url",
            url: part.url,
        } satisfies SourceUrlUIPart;
    }

    return {
        filename: part.filename,
        mediaType: part.mediaType,
        providerMetadata: part.providerMetadata as ProviderMetadata | undefined,
        sourceId: part.id,
        title: part.title,
        type: "source-document",
    } satisfies SourceDocumentUIPart;
};

const withNeoreLabel = (
    metadata: ProviderMetadata | undefined,
    partOptions: Record<string, Record<string, unknown>> | undefined,
): ProviderMetadata | undefined => {
    const label = partOptions?.neore;

    return label ? ({ ...metadata, neore: label } as ProviderMetadata) : metadata;
};

export const combineUIMessages = (messages: UIMessage[]): UIMessage[] => {
    const combined: UIMessage[] = [];

    for (const message of messages) {
        if (combined.length === 0) {
            combined.push(message);
            continue;
        }

        const previous = combined.at(-1)!;

        if (message.order !== previous.order || previous.role !== message.role || message.role !== "assistant") {
            combined.push(message);
            continue;
        }

        // We will replace it with a combined message
        combined.pop();
        const newParts = [...previous.parts];

        for (const part of message.parts) {
            const toolCallId = getToolCallId(part);

            if (!toolCallId) {
                newParts.push(part);
                continue;
            }

            const previousPartIndex = newParts.findIndex((p) => getToolCallId(p) === toolCallId);

            if (previousPartIndex === -1) {
                // Tool call not found in previous parts, add it as new
                newParts.push(part);
                continue;
            }

            const [previousPart] = newParts.splice(previousPartIndex, 1);

            if (previousPart) {
                newParts.push(mergeParts(previousPart, part));
            }
        }

        combined.push({
            ...previous,
            ...pick(message, ["status", "metadata", "agentName", "usage"]),
            ...((message.cost ?? previous.cost) && { cost: message.cost ?? previous.cost }),
            parts: newParts,
            text: joinText(newParts),
        });
    }

    return combined;
};

const getToolCallId = (part: UIMessage["parts"][number] & { toolCallId?: string }) => part.toolCallId;

const mergeParts = (previousPart: UIMessage["parts"][number], part: UIMessage["parts"][number]): UIMessage["parts"][number] => {
    // Later keys win, and a key whose incoming value is `undefined` is skipped so
    // it does not blank out what the previous part already carried.
    const merged = Object.fromEntries([...Object.entries(previousPart), ...Object.entries(part).filter(([, value]) => value !== undefined)]);

    return merged as ToolUIPart | DynamicToolUIPart;
};
