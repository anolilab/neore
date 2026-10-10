/**
 * Parser for Claude.ai export format.
 *
 * Claude uses a flat array of messages with senders "human" and "assistant".
 * Conversations are in a `conversations.json` file within the export ZIP.
 */
import type { NormalizedConversation, NormalizedMessage } from "./types";

interface ClaudeMessage {
    attachments?: unknown[];
    content?: string;
    created_at?: string; // ISO 8601 with microseconds
    files?: unknown[];
    sender: string; // "human" | "assistant"
    text?: string;
    updated_at?: string;
    uuid?: string;
}

interface ClaudeConversation {
    chat_messages?: ClaudeMessage[];
    created_at?: string; // ISO 8601 with microseconds
    name?: string;
    updated_at?: string;
    uuid?: string;
}

const normalizeRole = (sender: string): "user" | "assistant" | null => {
    const lower = sender.toLowerCase();

    if (lower === "human") {
        return "user";
    }

    if (lower === "assistant") {
        return "assistant";
    }

    return null;
};

const parseISOTimestamp = (iso?: string): number | undefined => {
    if (!iso) {
        return undefined;
    }

    const ts = new Date(iso).getTime();

    return Number.isNaN(ts) ? undefined : ts;
};

/**
 * Parse a single Claude conversation object.
 */
const parseClaudeConversation = (conv: ClaudeConversation): NormalizedConversation | null => {
    const rawMessages = conv.chat_messages;

    if (!rawMessages || rawMessages.length === 0) {
        return null;
    }

    const messages: NormalizedMessage[] = [];

    for (const message of rawMessages) {
        const role = normalizeRole(message.sender);

        if (!role) {
            continue;
        }

        const content = (message.text || message.content || "").trim();

        if (!content) {
            continue;
        }

        messages.push({
            content,
            createdAt: parseISOTimestamp(message.created_at),
            role,
        });
    }

    if (messages.length === 0) {
        return null;
    }

    return {
        createdAt: parseISOTimestamp(conv.created_at),
        messages,
        title: conv.name || "Untitled",
    };
};

/**
 * Parse Claude export data. Handles an array of conversation objects.
 */
const parseClaude = (data: unknown): NormalizedConversation[] => {
    if (!Array.isArray(data)) {
        // Might be a single conversation
        if (data && typeof data === "object" && "chat_messages" in data) {
            const result = parseClaudeConversation(data as ClaudeConversation);

            return result ? [result] : [];
        }

        throw new Error("Expected an array of conversations");
    }

    const conversations: NormalizedConversation[] = [];

    for (const conv of data as ClaudeConversation[]) {
        const result = parseClaudeConversation(conv);

        if (result) {
            conversations.push(result);
        }
    }

    return conversations;
};

export default parseClaude;
