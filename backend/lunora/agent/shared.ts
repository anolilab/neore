import type { JSONValue } from "@ai-sdk/provider";
import { getErrorMessage } from "@ai-sdk/provider";
import type {
    CustomPart,
    FilePart,
    ImagePart,
    ReasoningFilePart,
    ReasoningPart,
    Tool,
    ToolApprovalRequest,
    ToolCallPart,
    ToolResultOutput,
    ToolResultPart,
} from "@ai-sdk/provider-utils";
import type { ModelMessage, TextPart, UIDataTypes, UIMessagePart, UITools } from "ai";

import type { Message, MessageContentParts } from "./validators";

/**
 * Helper function to create a tool model output for approval responses.
 * @see ai `src/prompt/create-tool-model-output.ts`
 */
export const createToolModelOutput = async ({
    errorMode,
    input,
    output,
    tool,
    toolCallId,
}: {
    errorMode: "none" | "text" | "json";
    input: unknown;
    output: unknown;
    tool: Tool | undefined;
    toolCallId: string;
}): Promise<ToolResultOutput> => {
    if (errorMode === "text") {
        return { type: "error-text", value: getErrorMessage(output) };
    }

    if (errorMode === "json") {
        return { type: "error-json", value: toJSONValue(output) };
    }

    if (tool?.toModelOutput) {
        return await tool.toModelOutput({ input, output, toolCallId });
    }

    return typeof output === "string" ? { type: "text", value: output } : { type: "json", value: toJSONValue(output) };
};

const toJSONValue = (value: unknown): JSONValue => (value === undefined ? null : (value as JSONValue));

export const DEFAULT_RECENT_MESSAGES = 100;

export const isTool = (message: Message | ModelMessage) =>
    message.role === "tool" || (message.role === "assistant" && Array.isArray(message.content) && message.content.some((c) => c.type === "tool-call"));

export const extractText = (message: Message | ModelMessage) => {
    switch (message.role) {
        case "assistant": {
            if (typeof message.content === "string") {
                return message.content;
            }

            return joinText(message.content) || undefined;
        }
        case "system": {
            return message.content;
        }

        case "user": {
            if (typeof message.content === "string") {
                return message.content;
            }

            return joinText(message.content);
        }
        // we don't extract text from tool messages
        default: {
            break;
        }
    }

    return undefined;
};

/**
 * Every text part, joined.
 *
 * The union is written out rather than taken as `{ type: string }[]` because the
 * `p.type === "text"` filter is what narrows `p.text` into existence. ai@7 added
 * `ReasoningFilePart` and `CustomPart` to the assistant content union; neither
 * carries text, but both have to be ACCEPTED here or a whole `message.content`
 * array stops being passable.
 */
export const joinText = (
    parts: (
        | CustomPart
        | UIMessagePart<UIDataTypes, UITools>
        | TextPart
        | ImagePart
        | FilePart
        | ReasoningFilePart
        | ReasoningPart
        | ToolCallPart
        | ToolResultPart
        | MessageContentParts
        | ToolApprovalRequest
    )[],
) =>
    parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .filter(Boolean)
        .join(" ");

export const extractReasoning = (message: Message | ModelMessage) => {
    if (typeof message.content === "string") {
        return undefined;
    }

    return message.content
        .filter((c) => c.type === "reasoning")
        .map((c) => c.text)
        .join(" ");
};

export const DEFAULT_MESSAGE_RANGE = { after: 1, before: 2 };

export const sorted = <T extends { order: number; stepOrder: number }>(messages: T[], order: "asc" | "desc" = "asc"): T[] =>
    messages.toSorted(order === "asc" ? (a, b) => a.order - b.order || a.stepOrder - b.stepOrder : (a, b) => b.order - a.order || b.stepOrder - a.stepOrder);

export type ModelOrMetadata = string | (({ modelId: string } | { model: string }) & { provider: string });

export const getModelName = (embeddingModel: ModelOrMetadata): string => {
    if (typeof embeddingModel === "string") {
        if (embeddingModel.includes("/")) {
            return embeddingModel.split("/").slice(1).join("/");
        }

        return embeddingModel;
    }

    return "modelId" in embeddingModel ? embeddingModel.modelId : embeddingModel.model;
};

export const getProviderName = (embeddingModel: ModelOrMetadata): string => {
    if (typeof embeddingModel === "string") {
        return embeddingModel.split("/", 1).at(0)!;
    }

    return embeddingModel.provider;
};
