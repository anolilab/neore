/**
 * Main parser entry point. Auto-detects the provider from the JSON structure
 * and delegates to the appropriate parser.
 */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import parseChatGPT from "./chatgpt";
import parseClaude from "./claude";
import parseClaudeCode, { isClaudeCodeRecord } from "./claude-code";
import parseCodex, { isCodexRecord } from "./codex";
import parseGemini from "./gemini";
import parseNeore, { isNeoreExport } from "./neore";
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

/** Files that ship inside a ChatGPT export archive but hold no conversations. */
const NON_CONVERSATION_EXPORT_FILES = new Set([
    "account.json",
    "message_feedback.json",
    "model_comparisons.json",
    "projects.json",
    "shared_conversations.json",
    "user.json",
    "users.json",
]);

/**
 * Detect the provider from the JSON structure.
 *
 * Heuristics:
 * - ChatGPT: Array of objects with `mapping` field (tree-based messages)
 * - Claude: Array of objects with `chat_messages` field and `sender` = "human"
 * - Gemini: Object/array with `messages` field and role = "USER"/"MODEL".
 */
const detectProvider = (data: unknown): ImportProvider => {
    // Neore export root (`exportVersion` + `conversations`). Checked first: it is the only format whose
    // root object carries both, and a `.json` file arrives wrapped once in an array. Any entry will do: the parser skips the ones that are not exports.
    if (isNeoreExport(data) || (Array.isArray(data) && data.some((entry) => isNeoreExport(entry)))) {
        return "neore";
    }

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

        // Local transcripts: JSONL events. Matched on any record: a resumed session can open with
        // a long run of bookkeeping lines, and the check is a cheap property test per record.
        if (data.some((record) => isClaudeCodeRecord(record))) {
            return "claude-code";
        }

        if (data.some((record) => isCodexRecord(record))) {
            return "codex";
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

    throw new ChatImportError(
        msg`Could not detect the chat provider. Please ensure you uploaded a valid export file from ChatGPT, Gemini, Claude, or a Neore data export.`,
    );
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
        case "claude-code": {
            conversations = parseClaudeCode(data);
            break;
        }
        case "codex": {
            conversations = parseCodex(data);
            break;
        }
        case "gemini": {
            conversations = parseGemini(data);
            break;
        }
        case "neore": {
            conversations = parseNeore(data);
            break;
        }
        default: {
            throw new Error(`Unsupported provider: ${detectedProvider}`);
        }
    }

    return { conversations, provider: detectedProvider };
};

/** One JSON record per non-empty line; any damaged line stops the import (see the error). */
const parseJsonLines = (text: string): unknown[] => {
    const records: unknown[] = [];
    const lines = text
        .split("\n")
        .map((line, index) => {
            return { line, number: index + 1 };
        })
        .filter(({ line }) => line.trim());

    for (const { line, number } of lines) {
        try {
            records.push(JSON.parse(line));
        } catch {
            // Any damaged line stops the import: a turn cannot be dropped silently, and a
            // partial last line is indistinguishable from a complete but corrupt one.
            throw new ChatImportError(msg`Line ${number} of this transcript is not valid JSON, so the import was stopped.`);
        }
    }

    return records;
};

/**
 * Extract JSON from a file. Handles both direct JSON files
 * and JSON files within ZIP archives.
 */

/**
 * `onDamaged` receives the name of an archive member that cannot be read. The other members still import;
 * without it a damaged member fails the file, as a damaged file does.
 */
export const extractJsonFromFile = async (file: File, onDamaged?: (member: string) => void): Promise<unknown[]> => {
    const fileName = file.name.toLowerCase();

    if (fileName.endsWith(".json")) {
        const text = await file.text();
        const parsed = JSON.parse(text);

        return Array.isArray(parsed) ? [parsed] : [[parsed]];
    }

    if (fileName.endsWith(".jsonl")) {
        return [parseJsonLines(await file.text())];
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

            const lowerPath = path.toLowerCase();

            if (!lowerPath.endsWith(".json") && !lowerPath.endsWith(".jsonl")) {
                continue;
            }

            // Skip non-conversation files from ChatGPT exports
            const basename = path.split("/").pop()?.toLowerCase() ?? "";

            if (NON_CONVERSATION_EXPORT_FILES.has(basename)) {
                continue;
            }

            try {
                const text = await zipEntry.async("text");

                // A transcript is one array of records, as when it is selected directly.
                jsonFiles.push(lowerPath.endsWith(".jsonl") ? parseJsonLines(text) : JSON.parse(text));
            } catch (error) {
                // One damaged member must not cost the archive's other transcripts; it is reported by name.
                if (!onDamaged) {
                    throw error;
                }

                onDamaged(path);
            }
        }

        // An archive with no conversation files yields nothing; the selection's other files still import,
        // and a selection with nothing to import reports "No conversations found".
        return jsonFiles;
    }

    throw new ChatImportError(msg`Unsupported file format. Please upload a .json, .jsonl or .zip file.`);
};
