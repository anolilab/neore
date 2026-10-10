/**
 * Parser for ChatGPT export format (conversations.json from OpenAI data export).
 *
 * ChatGPT uses a tree-based message structure with parent/children references.
 * We walk from the root to `current_node` to reconstruct the linear conversation.
 */
import type { NormalizedConversation, NormalizedMessage } from "./types";

/**
 * A non-text content part (image asset, audio transcript, …). Only the
 * discriminator is ever read — these parts are dropped during normalisation.
 */
interface ChatGPTNonTextPart {
    content_type?: string;
}

type ChatGPTContentPart = ChatGPTNonTextPart | string;

interface ChatGPTMessage {
    children?: string[];
    id: string;
    message?: {
        author: { role: string };
        content: {
            content_type: string;
            parts?: ChatGPTContentPart[];
        };
        create_time?: number;
        id: string;
    };
    parent?: string;
}

interface ChatGPTConversation {
    conversation_id?: string;
    create_time?: number;
    current_node?: string;
    mapping: Record<string, ChatGPTMessage>;
    title: string;
    update_time?: number;
}

/**
 * Extract text content from a ChatGPT message's parts array.
 */
const extractTextFromParts = (parts?: ChatGPTContentPart[]): string => {
    if (!parts) {
        return "";
    }

    return parts
        .filter((part): part is string => typeof part === "string")
        .join("\n")
        .trim();
};

/**
 * Walk the message tree from current_node back to root to get the linear path,
 * then reverse to get chronological order.
 */
const linearizeConversation = (conv: ChatGPTConversation): NormalizedMessage[] => {
    const { current_node: currentNode, mapping } = conv;

    if (!mapping || !currentNode) {
        return [];
    }

    // Walk backwards from current_node to root
    const messageChain: ChatGPTMessage[] = [];
    let nodeId: string | undefined = currentNode;

    while (nodeId) {
        const node: ChatGPTMessage | undefined = mapping[nodeId];

        if (!node) {
            break;
        }

        messageChain.push(node);
        nodeId = node.parent;
    }

    // Reverse to get chronological order
    messageChain.reverse();

    // Convert to normalized messages, filtering out system/tool messages
    const messages: NormalizedMessage[] = [];

    for (const node of messageChain) {
        if (!node.message) {
            continue;
        }

        const { role } = node.message.author;

        if (role !== "user" && role !== "assistant") {
            continue;
        }

        const content = extractTextFromParts(node.message.content.parts);

        if (!content) {
            continue;
        }

        messages.push({
            content,
            createdAt: node.message.create_time
                ? Math.round(node.message.create_time * 1000) // Convert float seconds to ms
                : undefined,
            role: role as "user" | "assistant",
        });
    }

    return messages;
};

/**
 * Parse ChatGPT conversations.json content.
 */
const parseChatGPT = (data: unknown): NormalizedConversation[] => {
    if (!Array.isArray(data)) {
        throw new TypeError("Expected an array of conversations");
    }

    const conversations: NormalizedConversation[] = [];

    for (const conv of data as ChatGPTConversation[]) {
        if (!conv.mapping) {
            continue;
        }

        const messages = linearizeConversation(conv);

        if (messages.length === 0) {
            continue;
        }

        conversations.push({
            createdAt: conv.create_time ? Math.round(conv.create_time * 1000) : undefined,
            messages,
            title: conv.title || "Untitled",
        });
    }

    return conversations;
};

export default parseChatGPT;
