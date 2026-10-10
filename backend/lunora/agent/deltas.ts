import { getErrorMessage } from "@ai-sdk/provider-utils";
import {
    type DynamicToolUIPart,
    type ProviderMetadata,
    readUIMessageStream,
    type ReasoningUIPart,
    type TextStreamPart,
    type TextUIPart,
    type ToolSet,
    type ToolUIPart,
    type UIMessageChunk,
} from "ai";

import { pick } from "../lib/collections";
import { assert } from "../lib/error-helpers";
import { joinText, sorted } from "./shared";
import type { UIMessage } from "./ui-messages";
import type { MessageStatus, StreamDelta, StreamMessage } from "./validators";

export const blankUIMessage = <METADATA = unknown>(streamMessage: StreamMessage & { metadata?: METADATA }, threadId: string): UIMessage<METADATA> => {
    return {
        _creationTime: Date.now(),
        agentName: streamMessage.agentName,
        id: `stream:${streamMessage.streamId}`,
        key: `${threadId}-${streamMessage.order}-${streamMessage.stepOrder}`,
        order: streamMessage.order,
        parts: [],
        role: "assistant",
        status: statusFromStreamStatus(streamMessage.status),
        stepOrder: streamMessage.stepOrder,
        text: "",
        ...(streamMessage.metadata && { metadata: streamMessage.metadata }),
    };
};

export const statusFromStreamStatus = (status: StreamMessage["status"]): MessageStatus | "streaming" => {
    switch (status) {
        case "aborted": {
            return "failed";
        }
        case "finished": {
            return "success";
        }
        case "streaming": {
            return "streaming";
        }
        default: {
            return "pending";
        }
    }
};

export const updateFromUIMessageChunks = async (uiMessage: UIMessage, parts: UIMessageChunk[]) => {
    const partsStream = new ReadableStream<UIMessageChunk>({
        start(controller) {
            for (const part of parts) {
                controller.enqueue(part);
            }

            controller.close();
        },
    });
    let isFailed = false;
    let isSuppressError = false;
    const messageStream = readUIMessageStream({
        message: uiMessage,
        onError: (error) => {
            const errorMessage = error instanceof Error ? error.message : String(error);

            // Tool invocation errors can be safely ignored when streaming continuation
            // after tool approval - the stored messages have the complete tool context
            if (errorMessage.toLowerCase().includes("no tool invocation found")) {
                // Silently suppress - this is expected after tool approval when the
                // continuation stream has tool-result without the original tool-call
                isSuppressError = true;

                return;
            }

            isFailed = true;
            console.error("Error in stream", error);
        },
        stream: partsStream,
        terminateOnError: true,
    });
    let message = uiMessage;

    try {
        for await (const messagePart of messageStream) {
            assert(messagePart.id === message.id, `Expecting to only make one UIMessage in a stream`);
            message = messagePart;
        }
    } catch (error) {
        // If we've already handled this error in onError and marked it as suppressed,
        // don't rethrow - the stored messages provide the fallback
        if (!isSuppressError) {
            throw error;
        }
    }

    if (isFailed) {
        message.status = "failed";
    }

    message.text = joinText(message.parts);

    return message;
};

/** `errorText` on a tool call whose stream ended before its input was complete. */
export const INTERRUPTED_TOOL_CALL_ERROR = "The tool call was interrupted before its input was complete.";

type ChunkOf<T extends UIMessageChunk["type"]> = Extract<UIMessageChunk, { type: T }>;

/**
 * Make a stored chunk list safe to replay through `readUIMessageStream`.
 *
 * The SDK's reader assumes a whole, well-formed stream and THROWS on a chunk that
 * refers to something it never saw — a `tool-input-delta` without its
 * `tool-input-start`, a tool output for an unknown call, a `text-delta` without
 * its `text-start`. A persisted stream is not always whole: a paused or aborted
 * run, or a continuation after tool approval, can leave exactly those orphans,
 * and one of them used to discard the ENTIRE rebuilt message, text included.
 *
 * Orphans are dropped; there is nothing to attach them to, and the stored
 * messages still carry the complete tool context. A tool call whose input was
 * still streaming stays `input-streaming` while the stream is live; once the
 * stream is over (`isTerminal`) it can never complete, so it is closed as an
 * `output-error` instead of spinning forever.
 */
export const repairUIMessageChunks = (chunks: UIMessageChunk[], { isTerminal }: { isTerminal: boolean }): UIMessageChunk[] => {
    const openText = new Set<string>();
    const openReasoning = new Set<string>();
    const knownToolCalls = new Set<string>();
    const openToolInputs = new Map<string, { dynamic?: boolean; inputText: string; lastIndex: number; toolName: string }>();
    const repaired: UIMessageChunk[] = [];

    for (const chunk of chunks) {
        switch (chunk.type) {
            case "reasoning-delta": {
                if (!openReasoning.has(chunk.id)) continue;

                break;
            }
            case "reasoning-end": {
                if (!openReasoning.delete(chunk.id)) continue;

                break;
            }
            case "reasoning-start": {
                openReasoning.add(chunk.id);
                break;
            }
            case "text-delta": {
                if (!openText.has(chunk.id)) continue;

                break;
            }
            case "text-end": {
                if (!openText.delete(chunk.id)) continue;

                break;
            }
            case "text-start": {
                openText.add(chunk.id);
                break;
            }
            case "tool-approval-request":
            case "tool-output-available":
            case "tool-output-denied":
            case "tool-output-error": {
                if (!knownToolCalls.has(chunk.toolCallId)) continue;

                break;
            }
            case "tool-input-available":
            case "tool-input-error": {
                knownToolCalls.add(chunk.toolCallId);
                openToolInputs.delete(chunk.toolCallId);
                break;
            }
            case "tool-input-delta": {
                const open = openToolInputs.get(chunk.toolCallId);

                if (!open) continue;

                open.inputText += chunk.inputTextDelta;
                open.lastIndex = repaired.length;
                break;
            }
            case "tool-input-start": {
                knownToolCalls.add(chunk.toolCallId);
                openToolInputs.set(chunk.toolCallId, { dynamic: chunk.dynamic, inputText: "", lastIndex: repaired.length, toolName: chunk.toolName });
                break;
            }
            default: {
                break;
            }
        }

        repaired.push(chunk);
    }

    if (!isTerminal || openToolInputs.size === 0) {
        return repaired;
    }

    // Insert each closing chunk right after the call's own last chunk, so it lands
    // in the same step as the part it closes. Back to front keeps indices valid.
    const closings = [...openToolInputs].toSorted(([, a], [, b]) => b.lastIndex - a.lastIndex);

    for (const [toolCallId, open] of closings) {
        const closing: ChunkOf<"tool-input-error"> = {
            errorText: INTERRUPTED_TOOL_CALL_ERROR,
            input: open.inputText,
            toolCallId,
            toolName: open.toolName,
            type: "tool-input-error",
            ...(open.dynamic !== undefined && { dynamic: open.dynamic }),
        };

        repaired.splice(open.lastIndex + 1, 0, closing);
    }

    return repaired;
};

export const deriveUIMessagesFromDeltas = async (threadId: string, streamMessages: StreamMessage[], allDeltas: StreamDelta[]): Promise<UIMessage[]> => {
    const messages: UIMessage[] = [];

    for (const streamMessage of streamMessages) {
        if (streamMessage.format === "UIMessageChunk") {
            const { parts } = getParts<UIMessageChunk>(
                allDeltas.filter((d) => d.streamId === streamMessage.streamId),
                0,
            );
            const uiMessage = await updateFromUIMessageChunks(
                blankUIMessage(streamMessage, threadId),
                repairUIMessageChunks(parts, { isTerminal: streamMessage.status !== "streaming" }),
            );

            messages.push(uiMessage);
        } else {
            const [uiMessages] = deriveUIMessagesFromTextStreamParts(threadId, [streamMessage], [], allDeltas);

            messages.push(...uiMessages);
        }
    }

    return sorted(messages);
};

export const deriveUIMessagesFromTextStreamParts = (
    threadId: string,
    streamMessages: StreamMessage[],
    existingStreams: {
        cursor: number;
        message: UIMessage;
        streamId: string;
    }[],
    allDeltas: StreamDelta[],
): [UIMessage[], { cursor: number; message: UIMessage; streamId: string }[], boolean] => {
    const newStreams: {
        cursor: number;
        message: UIMessage;
        streamId: string;
    }[] = [];
    // Seed the existing chunks
    let isChanged = false;

    for (const streamMessage of streamMessages) {
        const deltas = allDeltas.filter((d) => d.streamId === streamMessage.streamId);
        const existing = existingStreams.find((s) => s.streamId === streamMessage.streamId);
        const [newStream, messageChanged] = updateFromTextStreamParts(threadId, streamMessage, existing, deltas);

        newStreams.push(newStream);

        if (messageChanged) {
            isChanged = true;
        }
    }

    for (const { streamId } of existingStreams) {
        if (newStreams.every((s) => s.streamId !== streamId)) {
            // There's a stream that's no longer active.
            isChanged = true;
        }
    }

    const messages = sorted(newStreams.map((s) => s.message));

    return [messages, newStreams, isChanged];
};

/**
 * Contiguous parts from a delta run, from `fromCursor` onwards.
 *
 * `T` is the caller's claim about the part shape, not something this function can
 * check: a stream's `format` field decides whether its parts are `UIMessageChunk`
 * or `TextStreamPart`, and that discriminator lives on the STREAM, one level up
 * from the deltas being walked here. The two call sites read it and pass the
 * matching type — the same "the caller knows and says so" arrangement as
 * `mergedStream<Doc<…>>`.
 */
export const getParts = <T extends StreamDelta["parts"][number]>(deltas: StreamDelta[], fromCursor = 0): { cursor: number; parts: T[] } => {
    const parts: T[] = [];
    let cursor = fromCursor;

    const orderedDeltas = deltas.toSorted((a, b) => a.start - b.start);

    for (const delta of orderedDeltas) {
        if (delta.parts.length === 0) {
            console.debug(`Got delta with no parts: ${JSON.stringify(delta)}`);
            continue;
        }

        if (cursor !== delta.start) {
            if (cursor >= delta.end) {
                continue;
            }

            if (cursor < delta.start) {
                console.warn(`Got delta for stream ${delta.streamId} that has a gap ${cursor} -> ${delta.start}`);
                break;
            }

            throw new Error(`Got unexpected delta for stream ${delta.streamId}: delta: ${delta.start} -> ${delta.end} existing cursor: ${cursor}`);
        }

        parts.push(...(delta.parts as T[]));
        cursor = delta.end;
    }

    return { cursor, parts };
};

/**
 * This is historically from when we would use the onChunk callback instead of
 * consuming the full UIMessageStream.
 */

// exported for testing
export const updateFromTextStreamParts = (
    threadId: string,
    streamMessage: StreamMessage,
    existing: { cursor: number; message: UIMessage; streamId: string } | undefined,
    deltas: StreamDelta[],
): [{ cursor: number; message: UIMessage; streamId: string }, boolean] => {
    const { cursor, parts } = getParts<TextStreamPart<ToolSet>>(deltas, existing?.cursor);
    const changed = parts.length > 0 || (existing && statusFromStreamStatus(streamMessage.status) !== existing.message.status);
    const existingMessage = existing?.message ?? blankUIMessage(streamMessage, threadId);

    if (!changed) {
        return [
            existing ?? {
                cursor,
                message: existingMessage,
                streamId: streamMessage.streamId,
            },
            false,
        ];
    }

    const message: UIMessage = structuredClone(existingMessage);

    message.status = statusFromStreamStatus(streamMessage.status);

    const textPartsById = new Map<string, TextUIPart>();
    const toolPartsById = new Map<string, ToolUIPart | DynamicToolUIPart>(
        message.parts.filter((p): p is ToolUIPart | DynamicToolUIPart => p.type.startsWith("tool-") || p.type === "dynamic-tool").map((p) => [p.toolCallId, p]),
    );
    const reasoningPartsById = new Map<string, ReasoningUIPart>();

    for (const part of parts) {
        switch (part.type) {
            case "abort": {
                message.status = "failed";
                break;
            }
            case "error": {
                message.status = "failed";
                console.warn("Generation failed with error", part.error);
                break;
            }
            case "file":
            case "finish":
            case "finish-step":
            case "raw":
            case "start":
            case "start-step":
            case "text-end": {
                // ignore
                break;
            }
            case "reasoning-delta":
            case "reasoning-start": {
                if (!reasoningPartsById.has(part.id)) {
                    const lastPart = message.parts.at(-1);

                    if (lastPart?.type === "reasoning") {
                        reasoningPartsById.set(part.id, lastPart);
                    } else {
                        const newPart = {
                            providerMetadata: part.providerMetadata,
                            state: "streaming",
                            text: "",
                            type: "reasoning",
                        } satisfies ReasoningUIPart;

                        reasoningPartsById.set(part.id, newPart);
                        message.parts.push(newPart);
                    }
                }

                const reasoningPart = reasoningPartsById.get(part.id)!;

                if (part.type === "reasoning-delta") {
                    reasoningPart.text += part.text;
                    reasoningPart.providerMetadata = mergeProviderMetadata(reasoningPart.providerMetadata, part.providerMetadata);
                }

                break;
            }
            case "reasoning-end": {
                const reasoningPart =
                    reasoningPartsById.get(part.id) ?? message.parts.find((p): p is ReasoningUIPart => p.type === "reasoning" && p.state === "streaming")!;

                if (reasoningPart) {
                    reasoningPart.state = "done";
                } else {
                    console.warn(`Expected to find reasoning part ${part.id} to finish, but found none`);
                }

                break;
            }
            case "source": {
                if (part.sourceType === "url") {
                    message.parts.push({
                        providerMetadata: part.providerMetadata,
                        sourceId: part.id,
                        title: part.title,
                        type: "source-url",
                        url: part.url,
                    });
                } else if (part.sourceType === "document") {
                    message.parts.push({
                        filename: part.filename,
                        mediaType: part.mediaType,
                        providerMetadata: part.providerMetadata,
                        sourceId: part.id,
                        title: part.title,
                        type: "source-document",
                    });
                } else {
                    console.warn("Got source part with unknown source type", part);
                }

                break;
            }
            case "text-delta":
            case "text-start": {
                if (!textPartsById.has(part.id)) {
                    const lastPart = message.parts.at(-1);

                    if (lastPart?.type === "text") {
                        textPartsById.set(part.id, lastPart);
                    } else {
                        const newPart = {
                            providerMetadata: part.providerMetadata,
                            text: "",
                            type: "text",
                        } satisfies TextUIPart;

                        textPartsById.set(part.id, newPart);
                        message.parts.push(newPart);
                    }
                }

                if (part.type === "text-delta") {
                    const textPart = textPartsById.get(part.id)!;

                    textPart.text += part.text;
                    textPart.providerMetadata = mergeProviderMetadata(textPart.providerMetadata, part.providerMetadata);
                }

                break;
            }
            case "tool-approval-request": {
                const typedPart = part as unknown as {
                    approvalId: string;
                    toolCallId: string;
                    type: "tool-approval-request";
                };
                const toolPart = toolPartsById.get(typedPart.toolCallId);

                if (toolPart) {
                    toolPart.state = "approval-requested";
                    (toolPart as ToolUIPart & { approval?: { approved?: boolean; id: string; reason?: string } }).approval = {
                        id: typedPart.approvalId,
                    };
                } else {
                    console.warn(`Expected tool call part ${typedPart.toolCallId} for approval request`);
                }

                break;
            }
            case "tool-call": {
                let newPart: ToolUIPart | DynamicToolUIPart;

                if (part.dynamic) {
                    newPart = {
                        input: part.input,
                        state: "input-available",
                        toolCallId: part.toolCallId,
                        toolName: part.toolName,
                        type: "dynamic-tool",
                    };
                } else {
                    newPart = {
                        input: part.input,
                        state: "input-available",
                        toolCallId: part.toolCallId,
                        type: `tool-${part.toolName}`,
                    };

                    if (part.providerExecuted) {
                        newPart.providerExecuted = part.providerExecuted;
                    }
                }

                if (part.providerMetadata) {
                    newPart.callProviderMetadata = part.providerMetadata;
                }

                if (toolPartsById.has(part.toolCallId)) {
                    const toUpdate = toolPartsById.get(part.toolCallId)!;

                    Object.assign(toUpdate, newPart);
                } else {
                    toolPartsById.set(part.toolCallId, newPart);
                    message.parts.push(newPart);
                }

                break;
            }
            case "tool-error": {
                const toolPart = toolPartsById.get(part.toolCallId);

                if (toolPart) {
                    toolPart.errorText = getErrorMessage(part.error);
                }

                break;
            }
            case "tool-input-delta": {
                {
                    const toUpdate = toolPartsById.get(part.id);

                    assert(toUpdate, `Expected to find tool call part ${part.id} to update`);
                    toUpdate.input = (toUpdate.input ?? "") + part.delta;
                }
                break;
            }
            case "tool-input-end": {
                {
                    const toUpdate = toolPartsById.get(part.id);

                    assert(toUpdate, `Expected to find tool call part ${part.id} to update`);
                    toUpdate.state = "input-available";

                    if (part.providerMetadata) {
                        const updatable = toUpdate as Extract<ToolUIPart | DynamicToolUIPart, { state: "input-available" }>;

                        updatable.callProviderMetadata = mergeProviderMetadata(updatable.callProviderMetadata, part.providerMetadata);
                    }
                }
                break;
            }
            case "tool-input-start": {
                let newPart: ToolUIPart | DynamicToolUIPart;

                if (part.dynamic) {
                    newPart = {
                        input: "",
                        state: "input-streaming",
                        toolCallId: part.id,
                        toolName: part.toolName,
                        type: "dynamic-tool",
                    } satisfies DynamicToolUIPart;
                } else {
                    newPart = {
                        input: "",
                        providerExecuted: part.providerExecuted,
                        state: "input-streaming",
                        toolCallId: part.id,
                        type: `tool-${part.toolName}`,
                    } satisfies ToolUIPart;
                }

                toolPartsById.set(part.id, newPart);
                message.parts.push(newPart);
                break;
            }
            case "tool-result": {
                const toolCall = toolPartsById.get(part.toolCallId);

                assert(toolCall, `Expected to find tool call part ${part.toolCallId} to update with result`);
                let newPart: ToolUIPart | DynamicToolUIPart;

                if (toolCall.type === "dynamic-tool") {
                    newPart = {
                        ...toolCall,
                        input: part.input ?? toolCall.input,
                        output: part.output ?? toolCall.output,
                        state: "output-available",
                        ...pick(part, ["preliminary"]),
                    } as DynamicToolUIPart;
                } else {
                    newPart = {
                        ...toolCall,
                        input: part.input ?? toolCall.input,
                        output: part.output ?? toolCall.output,
                        preliminary: part.preliminary,
                        state: "output-available",
                    } as ToolUIPart;
                }

                Object.assign(toolCall, newPart);
                break;
            }
            default: {
                // Exhaustiveness check disabled intentionally for forwards compatibility.
                // New TextStreamPart types from future AI SDK versions will trigger a
                // runtime warning rather than a compile error, allowing graceful degradation.
                // const _: never = part;
                console.warn(`Received unexpected part: ${JSON.stringify(part)}`);
                break;
            }
        }
    }

    // Consider reasoning done once something else happens
    for (let i = 0; i < message.parts.length - 1; i += 1) {
        const part = message.parts[i];

        if (part && part.type === "reasoning") {
            (part as ReasoningUIPart).state = "done";
        }
    }

    message.text = joinText(message.parts);

    return [
        {
            cursor,
            message,
            streamId: streamMessage.streamId,
        },
        true,
    ];
};

const mergeProviderMetadata = (existing: ProviderMetadata | undefined, part: ProviderMetadata | undefined): ProviderMetadata | undefined => {
    if (!existing && !part) {
        return undefined;
    }

    if (!existing) {
        return part;
    }

    if (!part) {
        return existing;
    }

    const merged: ProviderMetadata = existing;

    for (const [provider, metadata] of Object.entries(part)) {
        merged[provider] = {
            ...merged[provider],
            ...metadata,
        };
    }

    return merged;
};
