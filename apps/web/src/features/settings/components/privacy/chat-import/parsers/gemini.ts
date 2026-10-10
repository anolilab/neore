/**
 * Parser for Google Gemini export format (from Google Takeout).
 *
 * Gemini uses a flat array of messages with roles "USER" and "MODEL".
 * Each conversation is stored in a separate JSON file within the Takeout ZIP.
 */
import type { NormalizedConversation, NormalizedMessage } from "./types";

interface GeminiMessage {
    attachments?: unknown[];
    content?: string;
    createTime?: string; // ISO 8601
    id?: string;
    role: string; // "USER" | "MODEL"
    text?: string;
}

interface GeminiConversation {
    createTime?: string; // ISO 8601
    id?: string;
    messages?: GeminiMessage[];
    title?: string;
    updateTime?: string;
}

const normalizeRole = (role: string): "user" | "assistant" | null => {
    const upper = role.toUpperCase();

    if (upper === "USER") {
        return "user";
    }

    if (upper === "MODEL") {
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
 * Parse a single Gemini conversation object.
 */
const parseGeminiConversation = (conv: GeminiConversation): NormalizedConversation | null => {
    if (!conv.messages || conv.messages.length === 0) {
        return null;
    }

    const messages: NormalizedMessage[] = [];

    for (const message of conv.messages) {
        const role = normalizeRole(message.role);

        if (!role) {
            continue;
        }

        const content = (message.text || message.content || "").trim();

        if (!content) {
            continue;
        }

        messages.push({
            content,
            createdAt: parseISOTimestamp(message.createTime),
            role,
        });
    }

    if (messages.length === 0) {
        return null;
    }

    return {
        createdAt: parseISOTimestamp(conv.createTime),
        messages,
        title: conv.title || "Untitled",
    };
};

/**
 * Parse Gemini export data. Handles both:
 * - A single conversation object
 * - An array of conversation objects.
 */
const parseGemini = (data: unknown): NormalizedConversation[] => {
    const conversations: NormalizedConversation[] = [];

    if (Array.isArray(data)) {
        for (const conv of data as GeminiConversation[]) {
            const result = parseGeminiConversation(conv);

            if (result) {
                conversations.push(result);
            }
        }
    } else if (data && typeof data === "object" && "messages" in data) {
        // Single conversation
        const result = parseGeminiConversation(data as GeminiConversation);

        if (result) {
            conversations.push(result);
        }
    }

    return conversations;
};

export default parseGemini;
