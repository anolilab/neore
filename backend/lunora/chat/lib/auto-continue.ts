/**
 * Auto-Continue System
 *
 * Extends the existing agent streamText/generateText pipeline with:
 * - Higher maxSteps (up to 25 iterations) for complex multi-step tasks
 * - Context window management (compression when nearing model limits)
 * - Enhanced status events for frontend progress tracking
 *
 * This hooks INTO the existing AI SDK iteration loop via prepareStep/onStepFinish
 * rather than replacing it. See agent/client/streamText.ts for the underlying loop.
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Approximate characters per token for English text */
const CHARS_PER_TOKEN = 4;
/** Estimated token cost for image content parts (~1000 tokens) */
const IMAGE_TOKEN_ESTIMATE_CHARS = 4000;
/** Estimated token cost for file content parts (~500 tokens) */
const FILE_TOKEN_ESTIMATE_CHARS = 2000;
/** Overhead chars for tool call framing (name, JSON structure) */
const TOOL_CALL_OVERHEAD_CHARS = 100;
/** Safety margin applied to token estimates to avoid context overflow */
const ESTIMATION_SAFETY_MARGIN = 1.15;
/** Number of recent messages to always keep during compression */
const RECENT_MESSAGES_TO_KEEP = 6;
/** Max chars per message in compression summaries */
const SUMMARY_TRUNCATION_LENGTH = 200;

// ─── Stream Event Types ─────────────────────────────────────────────────────

export type AutoContinueStreamEvent =
    | { data: { iteration: number; status: "thinking" | "compressing" | "executing_tools" | "finalizing"; toolCallCount?: number }; type: "status_update" }
    | { data: { iteration: number; toolName: string }; type: "tool_call_started" }
    | { data: { iteration: number; toolCallCount: number; totalTokens: number }; type: "iteration_complete" }
    | { data: { iterations: number; toolCalls: number; totalTokens: number }; type: "done" };

// ─── Token Estimation ───────────────────────────────────────────────────────

/**
 * Fast approximate token count. Avoids tiktoken dependency.
 * Rough estimate: 1 token ≈ 4 characters for English text.
 * Applies a 15% safety margin to guard against estimation error.
 * Images and files get fixed estimates.
 */
export const estimateTokens = (messages: ModelMessage[]): number => {
    let totalChars = 0;

    for (const message of messages) {
        const { content } = message;

        if (typeof content === "string") {
            totalChars += content.length;
        } else if (Array.isArray(content)) {
            // `ModelMessage` parts are always objects, but this also runs over
            // history rebuilt from storage — keep the string branch reachable by
            // widening the element type instead of narrowing it to `never`.
            const parts: ReadonlyArray<unknown> = content;

            for (const part of parts) {
                if (typeof part === "string") {
                    totalChars += part.length;
                } else if (part && typeof part === "object") {
                    const p = part as { args?: unknown; content?: unknown; result?: unknown; text?: unknown; type?: unknown };

                    if (p.type === "text" && typeof p.text === "string") {
                        totalChars += p.text.length;
                    } else {
                        switch (p.type) {
                            case "file": {
                                totalChars += FILE_TOKEN_ESTIMATE_CHARS;

                                break;
                            }
                            case "image": {
                                totalChars += IMAGE_TOKEN_ESTIMATE_CHARS;

                                break;
                            }
                            case "tool-call": {
                                try {
                                    totalChars += JSON.stringify(p.args ?? "").length + TOOL_CALL_OVERHEAD_CHARS;
                                } catch {
                                    totalChars += 500;
                                }

                                break;
                            }
                            case "tool-result": {
                                const resultContent = p.content ?? p.result;

                                if (typeof resultContent === "string") {
                                    totalChars += resultContent.length;
                                } else {
                                    try {
                                        totalChars += JSON.stringify(resultContent ?? "").length;
                                    } catch {
                                        totalChars += 1000; // Fallback for circular refs
                                    }
                                }

                                break;
                            }
                            // No default
                            default: {
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    // Apply safety margin to avoid context overflow from estimation error
    return Math.ceil((totalChars / CHARS_PER_TOKEN) * ESTIMATION_SAFETY_MARGIN);
};

// ─── Context Window Sizes ───────────────────────────────────────────────────

/**
 * Known context window sizes by model ID pattern.
 * Falls back to 128K if unknown. Checked from most specific to least.
 */
export const getModelContextWindow = (modelId: string): number => {
    const id = modelId.toLowerCase();

    // Gemini models: 1M-2M context
    if (id.includes("gemini-2")) {
        return 1_000_000;
    }

    if (id.includes("gemini")) {
        return 1_000_000;
    }

    // Claude Haiku: 200K (same as larger models)
    if (id.includes("claude")) {
        return 200_000;
    }

    // OpenAI models
    if (id.includes("o3") || id.includes("o4-mini")) {
        return 200_000;
    }

    if (id.includes("o1")) {
        return 200_000;
    }

    if (id.includes("gpt-4.1")) {
        return 1_000_000;
    }

    if (id.includes("gpt-4o")) {
        return 128_000;
    }

    if (id.includes("gpt-4-turbo")) {
        return 128_000;
    }

    // DeepSeek
    if (id.includes("deepseek")) {
        return 128_000;
    }

    // Grok
    if (id.includes("grok")) {
        return 131_000;
    }

    // Llama models
    if (id.includes("llama-4")) {
        return 256_000;
    }

    if (id.includes("llama-3")) {
        return 128_000;
    }

    if (id.includes("llama")) {
        return 128_000;
    }

    // Mistral models
    if (id.includes("mistral-large")) {
        return 128_000;
    }

    if (id.includes("mistral") || id.includes("ministral") || id.includes("magistral")) {
        return 128_000;
    }

    if (id.includes("devstral")) {
        return 128_000;
    }

    // Qwen
    if (id.includes("qwen")) {
        return 128_000;
    }

    return 128_000;
};

// ─── Context Compression ────────────────────────────────────────────────────

/**
 * Compresses older messages in the conversation to fit within context limits.
 * Keeps system messages and recent exchanges intact, summarizes the rest.
 *
 * Returns compressed messages array, or the original if no compression needed.
 */
export const compressContextMessages = (messages: ModelMessage[], contextLimit: number): ModelMessage[] => {
    const currentTokens = estimateTokens(messages);

    const threshold = DEFAULT_AUTO_CONTINUE_CONFIG.compressionThreshold;

    if (currentTokens < contextLimit * threshold) {
        return messages; // No compression needed
    }

    // Separate system messages from conversation
    const systemMessages = messages.filter((m) => m.role === "system");
    const conversationMessages = messages.filter((m) => m.role !== "system");

    if (conversationMessages.length <= RECENT_MESSAGES_TO_KEEP) {
        return messages; // Too few to compress
    }

    // Keep last N messages (recent exchanges) intact
    const recentMessages = conversationMessages.slice(-RECENT_MESSAGES_TO_KEEP);
    const olderMessages = conversationMessages.slice(0, -RECENT_MESSAGES_TO_KEEP);

    // Summarize older messages into a compact format
    const summaryParts: string[] = [];

    for (const message of olderMessages) {
        const role = message.role || "unknown";
        const { content } = message;
        let text = "";

        if (typeof content === "string") {
            text = content;
        } else if (Array.isArray(content)) {
            text = content
                .map((p: any) => {
                    if (typeof p === "string") {
                        return p;
                    }

                    if (p?.type === "text") {
                        return p.text;
                    }

                    if (p?.type === "tool-call") return `[Tool: ${p.toolName}]`;

                    if (p?.type === "tool-result") return `[Result: ${String(p.content ?? p.result ?? "").slice(0, SUMMARY_TRUNCATION_LENGTH)}]`;

                    return "";
                })
                .filter(Boolean)
                .join(" ");
        }

        if (text) {
            const truncated = text.length > SUMMARY_TRUNCATION_LENGTH ? `${text.slice(0, SUMMARY_TRUNCATION_LENGTH)}...` : text;

            summaryParts.push(`${role}: ${truncated}`);
        }
    }

    // Cap total summary size to avoid the summary itself being too large
    let summaryText = `[Earlier conversation summary — ${olderMessages.length} messages compressed]\n`;
    let summaryChars = summaryText.length;
    const maxSummaryChars = Math.floor(contextLimit * 0.2 * CHARS_PER_TOKEN); // ~20% of context for summary

    for (let i = 0; i < summaryParts.length; i += 1) {
        const part = summaryParts[i]!;

        if (summaryChars + part.length + 1 > maxSummaryChars) {
            summaryText += `[...and ${summaryParts.length - i} more messages]\n`;
            break;
        }

        summaryText += `${part}\n`;
        summaryChars += part.length + 1;
    }

    const compressed = [
        ...systemMessages,
        // Use "user" role for summary to avoid conflicting with the real system prompt
        { content: `[Context from earlier in this conversation]\n${summaryText}`, role: "user" as const } as unknown as ModelMessage,
        ...recentMessages,
    ];

    // Post-compression size check — if still over limit, drop the summary entirely
    const compressedTokens = estimateTokens(compressed);

    if (compressedTokens > contextLimit * threshold) {
        return [...systemMessages, ...recentMessages];
    }

    return compressed;
};

// ─── Auto-Continue Configuration ────────────────────────────────────────────

export interface AutoContinueConfig {
    /** Fraction of context window that triggers compression. Default: 0.8 */
    compressionThreshold: number;
    /** Model context window size in tokens */
    contextWindowSize: number;
    /** Maximum number of iterations. Default: 25 */
    maxIterations: number;
    /** Callback for streaming status events to the frontend */
    onStatusEvent?: (event: AutoContinueStreamEvent) => void;
}

export const DEFAULT_AUTO_CONTINUE_CONFIG: AutoContinueConfig = {
    compressionThreshold: 0.8,
    contextWindowSize: 128_000,
    maxIterations: 25,
};

// ─── Context-Exceeded Error Detection ───────────────────────────────────────

/**
 * Known error patterns from AI providers when context window is exceeded.
 * Each provider returns different error messages/codes.
 */
const CONTEXT_EXCEEDED_PATTERNS = [
    // OpenAI / OpenRouter
    "context_length_exceeded",
    "maximum context length",
    "max_tokens",
    "context window",
    "token limit",
    // Anthropic
    "prompt is too long",
    "exceeds the maximum number of tokens",
    "request too large",
    // Google / Gemini
    "exceeds the maximum",
    "too many tokens",
    "input too long",
    // Generic
    "context exceeded",
    "content too large",
    "payload too large",
] as const;

/**
 * Detects whether an error is a context-window-exceeded error from any AI provider.
 * Checks the error message, cause chain, and common error code fields.
 */
export const isContextExceededError = (error: unknown): boolean => {
    const message = extractErrorText(error);

    if (!message) {
        return false;
    }

    const lower = message.toLowerCase();

    return CONTEXT_EXCEEDED_PATTERNS.some((pattern) => lower.includes(pattern));
};

/** Recursively extract text from an error, including nested causes. */
const extractErrorText = (error: unknown): string => {
    if (!error) {
        return "";
    }

    if (typeof error === "string") {
        return error;
    }

    if (error instanceof Error) {
        // Provider SDKs hang non-standard `code`/`statusCode` off their Error
        // subclasses; neither is on the `Error` interface, so widen structurally
        // rather than assuming a particular SDK's error class.
        const providerError = error as Error & { code?: unknown; statusCode?: unknown };
        const parts = [error.message];

        if (providerError.code) {
            parts.push(String(providerError.code));
        }

        if (providerError.statusCode) {
            parts.push(String(providerError.statusCode));
        }

        if (error.cause) {
            parts.push(extractErrorText(error.cause));
        }

        return parts.join(" ");
    }

    if (typeof error === "object") {
        const errorObject = error as { code?: unknown; error?: unknown; message?: unknown; statusCode?: unknown };
        const parts: string[] = [];

        if (errorObject.message) {
            parts.push(String(errorObject.message));
        }

        if (errorObject.error) {
            parts.push(typeof errorObject.error === "string" ? errorObject.error : extractErrorText(errorObject.error));
        }

        if (errorObject.code) {
            parts.push(String(errorObject.code));
        }

        if (errorObject.statusCode) {
            parts.push(String(errorObject.statusCode));
        }

        return parts.join(" ");
    }

    return String(error);
};

// ─── Late Compression ───────────────────────────────────────────────────────

/** Threshold at which late compression kicks in (fraction of context window). */
const LATE_COMPRESSION_THRESHOLD = 0.85;

/**
 * Applies "late compression" to messages before they are sent to the LLM.
 * This is a preventive measure that compresses context when it's close to
 * the model's limit, avoiding context-exceeded errors entirely.
 *
 * Returns the original messages if no compression is needed.
 */
export const applyLateCompression = (messages: ModelMessage[], modelId: string): ModelMessage[] => {
    const contextWindow = getModelContextWindow(modelId);
    const currentTokens = estimateTokens(messages);

    if (currentTokens < contextWindow * LATE_COMPRESSION_THRESHOLD) {
        return messages; // Plenty of room
    }

    // Apply standard compression
    const compressed = compressContextMessages(messages, contextWindow);

    // If standard compression wasn't enough, try aggressive compression
    // (keep fewer messages, shorter summaries)
    const compressedTokens = estimateTokens(compressed);

    if (compressedTokens >= contextWindow * LATE_COMPRESSION_THRESHOLD) {
        return aggressiveCompressMessages(compressed, contextWindow);
    }

    return compressed;
};

/**
 * More aggressive compression for when standard compression isn't sufficient.
 * Keeps only system messages + last 4 messages, with minimal summaries.
 */
const aggressiveCompressMessages = (messages: ModelMessage[], contextLimit: number): ModelMessage[] => {
    const AGGRESSIVE_RECENT_KEEP = 4;

    const systemMessages = messages.filter((m) => m.role === "system");
    const conversationMessages = messages.filter((m) => m.role !== "system");

    if (conversationMessages.length <= AGGRESSIVE_RECENT_KEEP) {
        return messages;
    }

    const AGGRESSIVE_SUMMARY_LENGTH = 100;

    const recentMessages = conversationMessages.slice(-AGGRESSIVE_RECENT_KEEP);
    const olderMessages = conversationMessages.slice(0, -AGGRESSIVE_RECENT_KEEP);

    // Build a very short summary
    const summaryParts: string[] = [];

    for (const message of olderMessages) {
        const role = message.role || "unknown";
        const { content } = message;
        let text = "";

        if (typeof content === "string") {
            text = content;
        } else if (Array.isArray(content)) {
            text = content
                .map((p: any) => {
                    if (typeof p === "string") {
                        return p;
                    }

                    if (p?.type === "text") {
                        return p.text;
                    }

                    if (p?.type === "tool-call") return `[Tool: ${p.toolName}]`;

                    if (p?.type === "tool-result") {
                        return "[Result]";
                    }

                    return "";
                })
                .filter(Boolean)
                .join(" ");
        }

        if (text) {
            summaryParts.push(`${role}: ${text.slice(0, AGGRESSIVE_SUMMARY_LENGTH)}${text.length > AGGRESSIVE_SUMMARY_LENGTH ? "..." : ""}`);
        }
    }

    // Cap summary to ~10% of context
    let summaryText = `[Conversation summary — ${olderMessages.length} messages]\n`;
    let summaryChars = summaryText.length;
    const maxSummaryChars = Math.floor(contextLimit * 0.1 * CHARS_PER_TOKEN);

    for (const part of summaryParts) {
        if (summaryChars + part.length + 1 > maxSummaryChars) {
            break;
        }

        summaryText += `${part}\n`;
        summaryChars += part.length + 1;
    }

    return [
        ...systemMessages,
        { content: `[Context from earlier in this conversation]\n${summaryText}`, role: "user" as const } as unknown as ModelMessage,
        ...recentMessages,
    ];
};

/**
 * Determines the maxSteps value based on whether auto-continue is enabled.
 *
 * When auto-continue is active, uses higher maxSteps (up to 25).
 * Otherwise falls back to the model's default (typically 5).
 */
export const getMaxSteps = (shouldAutoContinue: boolean, modelDefault = 5): number =>
    shouldAutoContinue ? DEFAULT_AUTO_CONTINUE_CONFIG.maxIterations : modelDefault;
