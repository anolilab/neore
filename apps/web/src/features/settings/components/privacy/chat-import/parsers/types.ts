/**
 * Normalized conversation format used internally.
 * All provider-specific parsers convert to this common shape.
 */
export interface NormalizedMessage {
    content: string;
    createdAt?: number; // Unix timestamp in ms
    role: "user" | "assistant";
}

export interface NormalizedConversation {
    createdAt?: number; // Unix timestamp in ms
    messages: NormalizedMessage[];
    title: string;
}

export type ImportProvider = "chatgpt" | "gemini" | "claude";

export interface ParseResult {
    conversations: NormalizedConversation[];
    provider: ImportProvider;
}
