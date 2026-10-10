/**
 * Main parser entry point. Auto-detects the provider from the JSON structure
 * and delegates to the appropriate parser.
 */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import parseChatGPT from "./chatgpt";
import parseClaude from "./claude";
import parseGemini from "./gemini";
import type { ImportProvider, NormalizedConversation, ParseResult } from "./types";

export type { ImportProvider, NormalizedConversation, NormalizedMessage, ParseResult } from "./types";

/**
 * An import failure the user should read. It carries a descriptor so the UI can
 * translate it; `message` stays the English source for logs and tests.
 */
export class ChatImportError extends Error {
    public readonly descriptor: MessageDescriptor;

    public constructor(descriptor: MessageDescriptor) {
        super(descriptor.message ?? descriptor.id);
        this.name = "ChatImportError";
        this.descriptor = descriptor;
    }
}

/**
 * Detect the provider from the JSON structure.
 *
 * Heuristics:
 * - ChatGPT: Array of objects with `mapping` field (tree-based messages)
 * - Claude: Array of objects with `chat_messages` field and `sender` = "human"
 * - Gemini: Object/array with `messages` field and role = "USER"/"MODEL".
 */
/** Files that ship inside a ChatGPT export archive but hold no conversations. */
const NON_CONVERSATION_EXPORT_FILES = new Set(["account.json", "message_feedback.json", "model_comparisons.json", "shared_conversations.json", "user.json"]);

const detectProvider = (data: unknown): ImportProvider => {
    if (Array.isArray(data) && data.length > 0) {
        const first = data[0];

        // ChatGPT: conversations have a `mapping` object
        if (first && typeof first === "object" && "mapping" in first) {
            return "chatgpt";
        }

        // Claude: conversations have `chat_messages` with `sender` field
        if (first && typeof first === "object" && "chat_messages" in first) {
            return "claude";
        }

        // Gemini: conversations have `messages` with "USER"/"MODEL" roles
        if (first && typeof first === "object" && "messages" in first) {
            const msgs = (first as { messages?: unknown[] }).messages;

            if (Array.isArray(msgs) && msgs.length > 0) {
                const firstMessage = msgs[0] as { role?: string };

                if (firstMessage?.role === "USER" || firstMessage?.role === "MODEL") {
                    return "gemini";
                }
            }
        }
    }

    // Single conversation object
    if (data && typeof data === "object" && !Array.isArray(data)) {
        if ("chat_messages" in data) {
            return "claude";
        }

        if ("mapping" in data) {
            return "chatgpt";
        }

        if ("messages" in data) {
            const msgs = (data as { messages?: unknown[] }).messages;

            if (Array.isArray(msgs) && msgs.length > 0) {
                const firstMessage = msgs[0] as { role?: string };

                if (firstMessage?.role === "USER" || firstMessage?.role === "MODEL") {
                    return "gemini";
                }
            }
        }
    }

    throw new ChatImportError(msg`Could not detect the chat provider. Please ensure you uploaded a valid export file from ChatGPT, Gemini, or Claude.`);
};

/**
 * Parse a JSON export file and return normalized conversations.
 * Auto-detects the provider if not explicitly specified.
 */
export const parseExportFile = (data: unknown, provider?: ImportProvider): ParseResult => {
    const detectedProvider = provider ?? detectProvider(data);

    let conversations: NormalizedConversation[];

    switch (detectedProvider) {
        case "chatgpt": {
            conversations = parseChatGPT(data);
            break;
        }
        case "claude": {
            conversations = parseClaude(data);
            break;
        }
        case "gemini": {
            conversations = parseGemini(data);
            break;
        }
        default: {
            throw new Error(`Unsupported provider: ${detectedProvider}`);
        }
    }

    return { conversations, provider: detectedProvider };
};

/**
 * Extract JSON from a file. Handles both direct JSON files
 * and JSON files within ZIP archives.
 */
export const extractJsonFromFile = async (file: File): Promise<unknown[]> => {
    const fileName = file.name.toLowerCase();

    if (fileName.endsWith(".json")) {
        const text = await file.text();
        const parsed = JSON.parse(text);

        return Array.isArray(parsed) ? [parsed] : [[parsed]];
    }

    if (fileName.endsWith(".zip")) {
        // Dynamically import JSZip for ZIP handling
        const { default: JSZip } = await import("jszip");
        const zip = await JSZip.loadAsync(file);

        const jsonFiles: unknown[] = [];

        for (const [path, zipEntry] of Object.entries(zip.files)) {
            if (zipEntry.dir) {
                continue;
            }

            if (!path.toLowerCase().endsWith(".json")) {
                continue;
            }

            // Skip non-conversation files from ChatGPT exports
            const basename = path.split("/").pop()?.toLowerCase() ?? "";

            if (NON_CONVERSATION_EXPORT_FILES.has(basename)) {
                continue;
            }

            try {
                const text = await zipEntry.async("text");
                const parsed = JSON.parse(text);

                jsonFiles.push(parsed);
            } catch {
                // Skip unparseable JSON files
            }
        }

        if (jsonFiles.length === 0) {
            throw new ChatImportError(msg`No valid JSON conversation files found in the ZIP archive.`);
        }

        return jsonFiles;
    }

    throw new ChatImportError(msg`Unsupported file format. Please upload a .json or .zip file.`);
};
