/**
 * Narrow a serialize context to one that can write storage.
 *
 * `serializeMessage` only touches storage on ONE branch: an inline image or file
 * whose bytes exceed `MAX_FILE_SIZE` gets stored and replaced with a URL. Every
 * other message goes nowhere near it.
 *
 * That branch is unreachable from an HTTP handler, because Lunora types an HTTP
 * ctx as `Pick<ActionCtx, "auth" | "cache" | "fetch" | "runAction" |
 * "runMutation" | "runQuery">` — no `storage`. Rather than
 * bar every HTTP caller from saving a plain text message, the requirement is
 * checked where it actually applies, and says what happened when it fails.
 */
import { toStorageRef } from "../lib/storage-ref";
import { storageRefsForUrls } from "../lib/storage-sign";
import { convertUint8ArrayToBase64, type ProviderOptions, type ReasoningPart, type ToolResultOutput } from "@ai-sdk/provider-utils";
import type {
    AssistantContent,
    CallWarning,
    DataContent,
    FilePart,
    FileUIPart,
    GenerateObjectResult,
    ImagePart,
    JSONValue,
    LanguageModelUsage,
    ModelMessage,
    ProviderMetadata,
    StepResult,
    TextPart,
    ToolCallPart,
    ToolContent,
    ToolResultPart,
    ToolSet,
    UIMessage as AIMessage,
    UserContent,
} from "ai";
import type { Infer } from "lunorash/server";

import { pick } from "../lib/collections";
import { parse, validate } from "../lib/validators";
import { MAX_FILE_SIZE, storeFile } from "./client/files";
import type { ActionCtx as ActionContext, RunnerCtx as RunnerContext } from "./client/types";
import type { MutationCtx as MutationContext } from "./client/types";
import { extractText, getModelName, getProviderName, type ModelOrMetadata } from "./shared";
import type { vAssistantContent, vToolApprovalRequest, vToolApprovalResponse, vToolContent } from "./validators";
import {
    type Message,
    type MessageDoc,
    type MessageWithMetadata,
    type SourcePart,
    type Usage,
    type vFilePart,
    type vImagePart,
    vMessageWithMetadata,
    type vReasoningPart,
    type vRedactedReasoningPart,
    type vSourcePart,
    type vTextPart,
    type vToolCallPart,
    vToolResultOutput,
    type vToolResultPart,
} from "./validators";

const DATA_URL_BASE64_PREFIX_RE = /^data:\w+\/\w+;base64/;

/** Any context message mapping may be handed. Only some of them carry storage. */
type MappingContext = ActionContext | MutationContext | RunnerContext;

const requireStorage = (context: MappingContext): ActionContext => {
    if (!("storage" in context)) {
        throw new Error("Cannot store an oversized inline attachment: this context has no storage (an HTTP action). Upload the file first and pass its id.");
    }

    return context as ActionContext;
};

export type AIMessageWithoutId = Omit<AIMessage, "id">;

export type SerializeUrlsAndUint8Arrays<T> = T extends URL
    ? string
    : T extends Uint8Array | ArrayBufferLike
      ? ArrayBuffer
      : T extends (infer Inner)[]
        ? SerializeUrlsAndUint8Arrays<Inner>[]
        : T extends Record<string, any>
          ? { [K in keyof T]: SerializeUrlsAndUint8Arrays<T[K]> }
          : T;

export type Content = UserContent | AssistantContent | ToolContent;
export type SerializedContent = Message["content"];

export type SerializedMessage = Message;

export const serializeMessage = async (
    context: MappingContext,
    message: ModelMessage | Message,
): Promise<{ fileIds?: string[]; message: SerializedMessage }> => {
    const { content, fileIds } = await serializeContent(context, message.content);

    return {
        fileIds,
        message: {
            content,
            role: message.role,
            ...(message.providerOptions && { providerOptions: message.providerOptions }),
        } as SerializedMessage,
    };
};

// Similar to serializeMessage, but doesn't save any files and is looser
// For use on the frontend / in synchronous environments.
export const fromModelMessage = (message: ModelMessage): Message => {
    const content = fromModelMessageContent(message.content);

    return {
        content,
        role: message.role,
        ...pick(message, ["providerOptions"]),
    } as SerializedMessage;
};

export const serializeOrThrow = async (message: ModelMessage | Message): Promise<SerializedMessage> => {
    const { content } = await serializeContent({} as never, message.content);

    return {
        content,
        role: message.role,
        ...pick(message, ["providerOptions"]),
    } as SerializedMessage;
};

export const toModelMessage = (message: SerializedMessage | ModelMessage): ModelMessage =>
    ({
        ...message,
        content: toModelMessageContent(message.content),
    }) as ModelMessage;

export const docsToModelMessages = (messages: MessageDoc[]): ModelMessage[] =>
    messages
        .map((m) => m.message)
        .filter((m) => !!m)
        .filter((m) => m.content.length > 0)
        .map((item) => toModelMessage(item));

export const serializeUsage = (usage: LanguageModelUsage): Usage => {
    // inputTokenDetails may exist in newer AI SDK versions (5.1+)
    const { inputTokenDetails } = usage as { inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } };

    return {
        cachedInputTokens: inputTokenDetails?.cacheReadTokens,
        // Cache token details (Anthropic's cacheCreationInputTokens maps to cacheWriteTokens)
        cacheReadTokens: inputTokenDetails?.cacheReadTokens,
        cacheWriteTokens: inputTokenDetails?.cacheWriteTokens,
        completionTokens: usage.outputTokens ?? 0,
        promptTokens: usage.inputTokens ?? 0,
        // ai@7 moved these off the top level: `reasoningTokens` is under
        // `outputTokenDetails`, and what used to be `cachedInputTokens` is
        // `inputTokenDetails.cacheReadTokens`.
        reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
        totalTokens: usage.totalTokens ?? 0,
    };
};

export const toModelMessageUsage = (usage: Usage): LanguageModelUsage => {
    return {
        // These detail fields are required by LanguageModelUsage type but we don't
        // have the granular data, so we provide empty objects with undefined values.
        inputTokenDetails: {
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            noCacheTokens: undefined,
        },
        inputTokens: usage.promptTokens,
        outputTokenDetails: {
            reasoningTokens: usage.reasoningTokens,
            textTokens: undefined,
        },
        outputTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
    };
};

export const serializeWarnings = (warnings: CallWarning[] | undefined): MessageWithMetadata["warnings"] => {
    if (!warnings) {
        return undefined;
    }

    return warnings.map((warning) => {
        if (warning.type === "compatibility") {
            return {
                details: warning.details,
                setting: warning.feature,
                type: "unsupported-setting" as const,
            };
        }

        return warning;
    }) as MessageWithMetadata["warnings"];
};

export const toModelMessageWarnings = (warnings: MessageWithMetadata["warnings"]): CallWarning[] | undefined => {
    if (!warnings) {
        return undefined;
    }

    return warnings.map((warning) => {
        if (warning.type === "unsupported-setting") {
            return {
                details: warning.details,
                feature: warning.setting,
                type: "compatibility" as const,
            };
        }

        return warning;
    }) as CallWarning[];
};

export const serializeNewMessagesInStep = async <TOOLS extends ToolSet>(
    context: ActionContext,
    step: StepResult<TOOLS>,
    model: ModelOrMetadata | undefined,
): Promise<{ messages: MessageWithMetadata[] }> => {
    // ref: https://github.com/vercel/ai/blob/main/packages/ai/core/generate-text/to-response-messages.ts
    const toolResultIndex = step.content.findIndex((c) => (c.type === "tool-result" || c.type === "tool-error") && !c.providerExecuted);
    const hasToolResults = toolResultIndex !== -1;
    const assistantContent = hasToolResults ? step.content.slice(0, toolResultIndex) : step.content;
    const { messageFileIds, partContent } = await serializeStepContent(context, assistantContent);
    // TODO: capture step.files separately?
    const message = {
        content: partContent as Infer<typeof vAssistantContent>,
        providerOptions: (hasToolResults ? step.response.messages.at(-2) : step.response.messages.at(-1))?.providerOptions,
        role: "assistant" as const,
    } satisfies Message;
    const messages = [
        parse(vMessageWithMetadata, {
            fileIds: messageFileIds,
            finishReason: step.finishReason,
            message,
            model: model ? getModelName(model) : undefined,
            provider: model ? getProviderName(model) : undefined,
            providerMetadata: step.providerMetadata,
            reasoning: step.reasoningText,
            reasoningDetails: step.reasoning,
            // Only store the sources on one message
            sources: assistantContent.filter((c) => c.type === "source"),
            text: extractText(message) || step.text,
            usage: serializeUsage(step.usage),
            warnings: serializeWarnings(step.warnings),
        }),
    ];

    if (hasToolResults) {
        const toolContent = step.content.slice(toolResultIndex);
        const { messageFileIds: toolFileIds, partContent: toolPartContent } = await serializeStepContent(context, toolContent);
        const toolMessage = {
            content: toolPartContent as Infer<typeof vToolContent>,
            providerOptions: step.response.messages.at(-1)?.providerOptions,
            role: "tool" as const,
        } satisfies Message;

        messages.push(
            parse(vMessageWithMetadata, {
                fileIds: toolFileIds,
                finishReason: step.finishReason,
                message: toolMessage,
                sources: toolContent.filter((c) => c.type === "source"),
            }),
        );
    }

    return { messages };
};

export const serializeObjectResult = async (
    context: ActionContext,
    result: GenerateObjectResult<unknown>,
    model: ModelOrMetadata | undefined,
): Promise<{ messages: MessageWithMetadata[] }> => {
    const text = JSON.stringify(result.object);

    const { fileIds, message } = await serializeMessage(context, {
        content: text,
        role: "assistant" as const,
    });

    return {
        messages: [
            {
                fileIds,
                finishReason: result.finishReason,
                message,
                model: model ? getModelName(model) : undefined,
                provider: model ? getProviderName(model) : undefined,
                providerMetadata: result.providerMetadata,
                text,
                usage: serializeUsage(result.usage),
                warnings: serializeWarnings(result.warnings),
            },
        ],
    };
};

const getMediaType = (part: { mediaType?: string }) => part.mediaType;

export const serializeStepContent = async (
    context: ActionContext,
    content: StepResult<ToolSet>["content"],
): Promise<{ messageFileIds?: string[]; partContent: SerializedContent }> => {
    const fileIds: string[] = [];
    const serialized = await Promise.all(
        content.map(async (part) => {
            const metadata: {
                providerMetadata?: ProviderMetadata;
                providerOptions?: ProviderOptions;
            } = {};

            if ("providerOptions" in part) {
                metadata.providerOptions = part.providerOptions as ProviderOptions;
            } else if ("providerMetadata" in part) {
                metadata.providerMetadata = part.providerMetadata;
            }

            switch (part.type) {
                case "file": {
                    const { uint8Array } = part.file;
                    let data: ArrayBuffer | string = uint8Array.buffer.slice(
                        uint8Array.byteOffset,
                        uint8Array.byteOffset + uint8Array.byteLength,
                    ) as ArrayBuffer;
                    const mediaType = getMediaType(part.file)!;

                    if (data.byteLength > MAX_FILE_SIZE) {
                        const { file } = await storeFile(context, new Blob([data], { type: mediaType }));

                        // Persist the reference, not a URL that expires (`agent/stored-media.ts`).
                        data = toStorageRef(file.storageId);
                        fileIds.push(file.fileId);
                    }

                    return {
                        data,
                        mediaType,
                        type: part.type,
                        ...metadata,
                    } satisfies Infer<typeof vFilePart>;
                }
                case "reasoning": {
                    return part satisfies Infer<typeof vReasoningPart>;
                }
                case "source": {
                    return part satisfies Infer<typeof vSourcePart>;
                }
                case "text": {
                    return part satisfies Infer<typeof vTextPart>;
                }
                case "tool-approval-request": {
                    // ai@7 carries the whole call (`toolCall`) on a step's approval
                    // request, where the stored prompt part names only its id. Left
                    // to `default`, the part fails validation, the step save throws
                    // inside `onStepFinish`, and the paused run is never recorded.
                    return {
                        approvalId: part.approvalId,
                        toolCallId: part.toolCall.toolCallId,
                        type: part.type,
                        ...metadata,
                    } satisfies Infer<typeof vToolApprovalRequest>;
                }
                case "tool-call": {
                    return {
                        ...pick(part, ["type", "toolCallId", "toolName", "providerExecuted"]),
                        input: part.input,
                        ...metadata,
                    } satisfies Infer<typeof vToolCallPart>;
                }
                case "tool-error": {
                    let errorOutput: Infer<typeof vToolResultPart>["output"];

                    if (part.error instanceof Error) {
                        errorOutput = { type: "error-text", value: part.error.message };
                    } else if (typeof part.error === "string") {
                        errorOutput = { type: "error-text", value: part.error };
                    } else {
                        errorOutput = { type: "error-json", value: part.error ?? null };
                    }

                    return {
                        ...pick(part, ["toolCallId", "toolName", "dynamic", "providerExecuted"]),
                        input: part.input,
                        output: errorOutput,
                        type: "tool-result",
                        ...metadata,
                    } satisfies Infer<typeof vToolResultPart>;
                }
                case "tool-result": {
                    const rawOutput = part.output;
                    const output: ToolResultOutput =
                        typeof rawOutput === "string" ? { type: "text", value: rawOutput } : { type: "json", value: part.output ?? null };

                    return {
                        ...pick(part, ["type", "toolCallId", "toolName", "dynamic", "preliminary", "providerExecuted"]),
                        input: part.input,
                        // Generated media is returned as a signed URL the model uses
                        // this turn; the stored row keeps the key instead
                        // (`lib/storage-sign.ts#storageRefsForUrls`), re-signed on read.
                        output: storageRefsForUrls(output),
                        ...metadata,
                    } satisfies Infer<typeof vToolResultPart>;
                }
                default: {
                    return part;
                }
            }
        }),
    );

    return {
        messageFileIds: fileIds.length > 0 ? fileIds : undefined,
        partContent: serialized as SerializedContent,
    };
};

export const serializeContent = async (
    context: MappingContext,
    content: Content | Message["content"],
): Promise<{ content: SerializedContent; fileIds?: string[] }> => {
    if (typeof content === "string") {
        return { content };
    }

    const fileIds: string[] = [];
    const serialized = await Promise.all(
        content.map(async (part) => {
            const metadata: {
                providerMetadata?: ProviderMetadata;
                providerOptions?: ProviderOptions;
            } = {};

            if ("providerOptions" in part) {
                metadata.providerOptions = part.providerOptions as ProviderOptions;
            }

            if ("providerMetadata" in part) {
                metadata.providerMetadata = part.providerMetadata as ProviderMetadata;
            }

            switch (part.type) {
                case "file": {
                    let data = serializeDataOrUrl(part.data);

                    if (data instanceof ArrayBuffer && data.byteLength > MAX_FILE_SIZE) {
                        const { file } = await storeFile(requireStorage(context), new Blob([data], { type: getMediaType(part) }));

                        // Persist the reference, not a URL that expires (`agent/stored-media.ts`).
                        data = toStorageRef(file.storageId);
                        fileIds.push(file.fileId);
                    }

                    return {
                        data,
                        filename: part.filename,
                        mediaType: getMediaType(part)!,
                        type: part.type,
                        ...metadata,
                    } satisfies Infer<typeof vFilePart>;
                }
                case "image": {
                    let image = serializeDataOrUrl(part.image);

                    if (image instanceof ArrayBuffer && image.byteLength > MAX_FILE_SIZE) {
                        const { file } = await storeFile(
                            requireStorage(context),
                            new Blob([image], {
                                type: getMediaType(part) || guessMimeType(image),
                            }),
                        );

                        image = toStorageRef(file.storageId);
                        fileIds.push(file.fileId);
                    }

                    return {
                        mediaType: getMediaType(part),
                        type: part.type,
                        ...metadata,
                        image,
                    } satisfies Infer<typeof vImagePart>;
                }
                case "reasoning": {
                    return {
                        text: part.text,
                        type: part.type,
                        ...metadata,
                    } satisfies Infer<typeof vReasoningPart>;
                }
                // Not in current generation output, but could be in historical messages
                case "redacted-reasoning": {
                    return {
                        data: part.data,
                        type: part.type,
                        ...metadata,
                    } satisfies Infer<typeof vRedactedReasoningPart>;
                }
                case "source": {
                    return part satisfies Infer<typeof vSourcePart>;
                }
                case "text": {
                    return {
                        text: part.text,
                        type: part.type,
                        ...metadata,
                    } satisfies Infer<typeof vTextPart>;
                }
                case "tool-approval-request": {
                    return {
                        approvalId: part.approvalId,
                        toolCallId: part.toolCallId,
                        type: part.type,
                        ...metadata,
                    } satisfies Infer<typeof vToolApprovalRequest>;
                }
                case "tool-approval-response": {
                    return {
                        approvalId: part.approvalId,
                        approved: part.approved,
                        providerExecuted: part.providerExecuted,
                        reason: part.reason,
                        type: part.type,
                        ...metadata,
                    } satisfies Infer<typeof vToolApprovalResponse>;
                }
                case "tool-call": {
                    return {
                        input: part.input ?? null,
                        providerExecuted: part.providerExecuted,
                        toolCallId: part.toolCallId,
                        toolName: part.toolName,
                        type: part.type,
                        ...metadata,
                    } satisfies Infer<typeof vToolCallPart>;
                }
                case "tool-result": {
                    // Persisted: signed storage URLs become references (see above).
                    const normalized = normalizeToolResult(part, metadata);

                    return { ...normalized, output: storageRefsForUrls(normalized.output) };
                }
                default: {
                    return null;
                }
            }
        }),
    );

    return {
        content: serialized.filter((p) => p !== null) as SerializedContent,
        fileIds: fileIds.length > 0 ? fileIds : undefined,
    };
};

export const fromModelMessageContent = (content: Content): Message["content"] => {
    if (typeof content === "string") {
        return content;
    }

    return content
        .map((part) => {
            const metadata: {
                providerMetadata?: ProviderMetadata;
                providerOptions?: ProviderOptions;
            } = {};

            if ("providerOptions" in part) {
                metadata.providerOptions = part.providerOptions as ProviderOptions;
            }

            if ("providerMetadata" in part) {
                metadata.providerMetadata = part.providerMetadata as ProviderMetadata;
            }

            switch (part.type) {
                case "file": {
                    return {
                        data: serializeDataOrUrl(part.data),
                        filename: part.filename,
                        mediaType: getMediaType(part)!,
                        type: part.type,
                        ...metadata,
                    } satisfies Infer<typeof vFilePart>;
                }
                case "image": {
                    return {
                        mediaType: getMediaType(part),
                        type: part.type,
                        ...metadata,
                        image: serializeDataOrUrl(part.image),
                    } satisfies Infer<typeof vImagePart>;
                }
                case "reasoning": {
                    return {
                        text: part.text,
                        type: part.type,
                        ...metadata,
                    } satisfies Infer<typeof vReasoningPart>;
                }
                case "text": {
                    return part satisfies Infer<typeof vTextPart>;
                }
                case "tool-approval-request": {
                    return {
                        approvalId: part.approvalId,
                        toolCallId: part.toolCallId,
                        type: part.type,
                        ...metadata,
                    } satisfies Infer<typeof vToolApprovalRequest>;
                }
                case "tool-approval-response": {
                    return {
                        approvalId: part.approvalId,
                        approved: part.approved,
                        providerExecuted: part.providerExecuted,
                        reason: part.reason,
                        type: part.type,
                        ...metadata,
                    } satisfies Infer<typeof vToolApprovalResponse>;
                }
                case "tool-call": {
                    return {
                        input: part.input ?? null,
                        providerExecuted: part.providerExecuted,
                        toolCallId: part.toolCallId,
                        toolName: part.toolName,
                        type: part.type,
                        ...metadata,
                    } satisfies Infer<typeof vToolCallPart>;
                }
                case "tool-result": {
                    return normalizeToolResult(part, metadata);
                }
                // Not in current generation output, but could be in historical messages
                default: {
                    return null;
                }
            }
        })
        .filter((p) => p !== null) as Message["content"];
};

export const toModelMessageContent = (content: SerializedContent | ModelMessage["content"]): Content => {
    if (typeof content === "string") {
        return content;
    }

    return content
        .map((part) => {
            const metadata: {
                providerMetadata?: ProviderMetadata;
                providerOptions?: ProviderOptions;
            } = {};

            // The stored part carries these as opaque JSON
            // (`Record<string, Record<string, unknown>>`); the SDK's own types have
            // `JSONValue` leaves, and `unknown` is not assignable to `JSONValue`.
            // Same storage/SDK boundary as `partCommon` in `uiMessages.ts`.
            if ("providerOptions" in part) {
                metadata.providerOptions = part.providerOptions as ProviderOptions;
            }

            if ("providerMetadata" in part) {
                metadata.providerMetadata = part.providerMetadata as ProviderMetadata;
            }

            switch (part.type) {
                case "file": {
                    return {
                        data: toModelMessageDataOrUrl(part.data),
                        filename: part.filename,
                        mediaType: getMediaType(part)!,
                        type: part.type,
                        ...metadata,
                    } satisfies FilePart;
                }
                case "image": {
                    return {
                        image: toModelMessageDataOrUrl(part.image),
                        mediaType: getMediaType(part),
                        type: part.type,
                        ...metadata,
                    } satisfies ImagePart;
                }
                case "reasoning": {
                    return {
                        text: part.text,
                        type: part.type,
                        ...metadata,
                    } satisfies ReasoningPart;
                }
                case "redacted-reasoning": {
                    // TODO: should we just drop this?
                    return {
                        text: "",
                        type: "reasoning",
                        ...metadata,
                        providerOptions: metadata.providerOptions
                            ? {
                                  ...Object.fromEntries(
                                      Object.entries(metadata.providerOptions ?? {}).map(([key, value]) => [key, { ...value, redactedData: part.data }]),
                                  ),
                              }
                            : undefined,
                    } satisfies ReasoningPart;
                }
                case "source": {
                    return part satisfies SourcePart;
                }
                case "text": {
                    return {
                        text: part.text,
                        type: part.type,
                        ...metadata,
                    } satisfies TextPart;
                }
                case "tool-approval-request":
                case "tool-approval-response": {
                    // Filter out approval parts - providers like Anthropic don't understand these
                    // and will error if they are included in messages sent to the API.
                    // The approval data is preserved in storage and extracted for UI rendering
                    // directly from message.message.content before toModelMessage is called.
                    return null;
                }
                case "tool-call": {
                    return {
                        input: part.input ?? null,
                        providerExecuted: part.providerExecuted,
                        toolCallId: part.toolCallId,
                        toolName: part.toolName,
                        type: part.type,
                        ...metadata,
                    } satisfies ToolCallPart;
                }
                case "tool-result": {
                    return normalizeToolResult(part, metadata);
                }
                default: {
                    // ai@7 added ReasoningFilePart and CustomPart to the inbound
                    // union. Neither is a `Content` member, and neither carries
                    // anything a stored message needs — dropped like the other
                    // non-persisted parts above.
                    return null;
                }
            }
        })
        .filter((part) => part !== null) as Content;
};

export const normalizeToolOutput = (result: string | JSONValue | undefined): ToolResultPart["output"] => {
    if (typeof result === "string") {
        return {
            type: "text",
            value: result,
        };
    }

    if (validate(vToolResultOutput, result)) {
        return result as ToolResultOutput;
    }

    return {
        type: "json",
        value: result ?? null,
    };
};

const normalizeToolResult = (
    part: ToolResultPart | Infer<typeof vToolResultPart>,
    metadata: {
        providerMetadata?: ProviderMetadata;
        providerOptions?: ProviderOptions;
    },
): Infer<typeof vToolResultPart> & ToolResultPart => {
    let { output } = part;

    // Convert execution-denied to text format for provider compatibility
    // Anthropic and other providers don't understand the execution-denied type
    if (output?.type === "execution-denied") {
        output = {
            type: "text",
            value: (output as { reason?: string }).reason ?? "Tool execution was denied by the user",
        };
    }

    const toolPart = part as Infer<typeof vToolResultPart> & ToolResultPart;

    return {
        dynamic: toolPart.dynamic,
        input: toolPart.input,
        output,
        preliminary: toolPart.preliminary,
        providerExecuted: toolPart.providerExecuted,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        type: part.type,
        ...metadata,
    } as Infer<typeof vToolResultPart> & ToolResultPart;
};

/**
 * Return a best-guess MIME type based on the magic-number signature
 * found at the start of an ArrayBuffer.
 * @param buffer – the source ArrayBuffer
 * @returns the detected MIME type, or `"application/octet-stream"` if unknown
 */
export const guessMimeType = (buffer: ArrayBuffer | string): string => {
    if (typeof buffer === "string") {
        if (DATA_URL_BASE64_PREFIX_RE.test(buffer)) {
            const mimeType = buffer.split(";", 1)[0]?.split(":", 2)[1];

            return mimeType ?? "application/octet-stream";
        }

        return "text/plain";
    }

    if (buffer.byteLength < 4) {
        return "application/octet-stream";
    }

    // Read the first 12 bytes (enough for all signatures below)
    const bytes = new Uint8Array(buffer.slice(0, 12));
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

    // Helper so we can look at only the needed prefix
    const startsWith = (sig: string) => hex.startsWith(sig.toLowerCase());

    // --- image formats ---
    if (startsWith("89504e47")) {
        return "image/png";
    } // PNG  - 89 50 4E 47

    if (startsWith("ffd8ffdb") || startsWith("ffd8ffe0") || startsWith("ffd8ffee") || startsWith("ffd8ffe1")) {
        return "image/jpeg";
    } // JPEG

    if (startsWith("47494638")) {
        return "image/gif";
    } // GIF

    if (startsWith("424d")) {
        return "image/bmp";
    } // BMP

    if (startsWith("52494646") && hex.slice(16, 24) === "57454250") {
        return "image/webp";
    } // WEBP (RIFF....WEBP)

    if (startsWith("49492a00")) {
        return "image/tiff";
    } // TIFF

    // <svg in hex is 3c 3f 78 6d 6c
    if (startsWith("3c737667")) {
        return "image/svg+xml";
    } // <svg

    if (startsWith("3c3f786d")) {
        return "image/svg+xml";
    } // <?xm

    // --- audio/video ---
    if (startsWith("494433")) {
        return "audio/mpeg";
    } // MP3 (ID3)

    if (startsWith("000001ba") || startsWith("000001b3")) {
        return "video/mpeg";
    } // MPEG container

    if (startsWith("1a45dfa3")) {
        return "video/webm";
    } // WEBM / Matroska

    if (startsWith("00000018") && hex.slice(16, 24) === "66747970") {
        return "video/mp4";
    } // MP4

    if (startsWith("4f676753")) {
        return "audio/ogg";
    } // OGG / Opus

    // --- documents & archives ---
    if (startsWith("25504446")) {
        return "application/pdf";
    } // PDF

    if (startsWith("504b0304") || startsWith("504b0506") || startsWith("504b0708")) {
        return "application/zip";
    } // ZIP / DOCX / PPTX / XLSX / EPUB

    if (startsWith("52617221")) {
        return "application/x-rar-compressed";
    } // RAR

    if (startsWith("7f454c46")) {
        return "application/x-elf";
    } // ELF binaries

    if (startsWith("1f8b08")) {
        return "application/gzip";
    } // GZIP

    if (startsWith("425a68")) {
        return "application/x-bzip2";
    } // BZIP2

    if (startsWith("3c3f786d6c")) {
        return "application/xml";
    } // XML

    // Plain text, JSON and others are trickier—fallback:
    return "application/octet-stream";
};

/**
 * Serialize an AI SDK `DataContent` or `URL` to a serializable format.
 * @param dataOrUrl The data or URL to serialize.
 * @returns The serialized data as an ArrayBuffer or the URL as a string.
 */
export const serializeDataOrUrl = (dataOrUrl: FilePart["data"] | ImagePart["image"]): ArrayBuffer | string => {
    if (typeof dataOrUrl === "string") {
        return dataOrUrl;
    }

    if (dataOrUrl instanceof ArrayBuffer) {
        return dataOrUrl; // Already an ArrayBuffer
    }

    if (dataOrUrl instanceof URL) {
        return dataOrUrl.toString();
    }

    if (ArrayBuffer.isView(dataOrUrl)) {
        return dataOrUrl.buffer.slice(dataOrUrl.byteOffset, dataOrUrl.byteOffset + dataOrUrl.byteLength) as ArrayBuffer;
    }

    // ai@7 widened this union with provider references and file-data handles —
    // shapes that name remote content rather than carrying bytes. There is nothing
    // to serialise, so the handle is passed through for the provider to resolve.
    return JSON.stringify(dataOrUrl);
};

export const toModelMessageDataOrUrl = (urlOrString: FilePart["data"] | ImagePart["image"]): URL | DataContent => {
    if (urlOrString instanceof URL) {
        return urlOrString;
    }

    if (typeof urlOrString === "string") {
        if (urlOrString.startsWith("http://") || urlOrString.startsWith("https://")) {
            return new URL(urlOrString);
        }

        return urlOrString;
    }

    if (urlOrString instanceof ArrayBuffer || ArrayBuffer.isView(urlOrString)) {
        return urlOrString;
    }

    // Provider references and file-data handles (added in ai@7) are not
    // `DataContent` — they name remote content. Pass them through; the provider
    // resolves them on its own side.
    return urlOrString as unknown as DataContent;
};

export const toUIFilePart = (part: ImagePart | FilePart | Infer<typeof vImagePart> | Infer<typeof vFilePart>): FileUIPart => {
    const dataOrUrl = part.type === "image" ? part.image : part.data;
    const url = dataOrUrl instanceof ArrayBuffer ? convertUint8ArrayToBase64(new Uint8Array(dataOrUrl)) : dataOrUrl.toString();

    const mediaType = getMediaType(part);

    return {
        filename: part.type === "file" ? part.filename : undefined,
        mediaType: mediaType!,
        // Storage/SDK boundary — the stored value has `unknown` leaves where
        // the SDK type wants `JSONValue`. Same cast as `partCommon` elsewhere.
        providerMetadata: part.providerOptions as ProviderMetadata,
        type: "file",
        url,
    };
};
