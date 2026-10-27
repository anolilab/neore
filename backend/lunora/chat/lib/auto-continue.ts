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
/** Replaces the output of a tool result that compression elides. The call keeps its id. */
const ELIDED_TOOL_OUTPUT = "[Tool output removed to fit the context window]";
/** Stands in for the summary when the summary alone would not fit. */
const DROPPED_SUMMARY_NOTE = "[Earlier conversation was removed to fit the context window]";

// ─── Stream Event Types ─────────────────────────────────────────────────────

export type AutoContinueStreamEvent =
    | { data: { iteration: number; status: "thinking" | "compressing" | "executing_tools" | "finalizing"; toolCallCount?: number }; type: "status_update" }
    | { data: { iteration: number; toolName: string }; type: "tool_call_started" }
    | { data: { iteration: number; toolCallCount: number; totalTokens: number }; type: "iteration_complete" }
    | { data: { iterations: number; toolCalls: number; totalTokens: number }; type: "done" };

// ─── Token Estimation ───────────────────────────────────────────────────────

/**
 * Text of a tool result. AI SDK 5+ stores `output: { type, value }`; `content`
 * and `result` are the pre-v5 names, kept for history rebuilt from old rows.
 */
const toolResultText = (part: { content?: unknown; output?: unknown; result?: unknown }): string => {
    const output = part.output ?? part.content ?? part.result;
    const value = output && typeof output === "object" && "value" in output ? (output as { value: unknown }).value : output;

    if (typeof value === "string") {
        return value;
    }

    try {
        return JSON.stringify(value ?? "") ?? "";
    } catch {
        return "[unserialisable tool output]"; // Circular refs never reach stored history
    }
};

/** Tokens for a character count, with the safety margin. */
const charsToTokens = (chars: number): number => Math.ceil((chars / CHARS_PER_TOKEN) * ESTIMATION_SAFETY_MARGIN);

/** The characters `estimateTokens` counts for a prompt. */
const estimateChars = (messages: ModelMessage[]): number => {
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
                    const p = part as {
                        args?: unknown;
                        content?: unknown;
                        input?: unknown;
                        output?: unknown;
                        result?: unknown;
                        text?: unknown;
                        type?: unknown;
                    };

                    if ((p.type === "text" || p.type === "reasoning") && typeof p.text === "string") {
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
                                    totalChars += JSON.stringify(p.input ?? p.args ?? "").length + TOOL_CALL_OVERHEAD_CHARS;
                                } catch {
                                    totalChars += 500;
                                }

                                break;
                            }
                            case "tool-result": {
                                totalChars += toolResultText(p).length;

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

    return totalChars;
};

/**
 * Fast approximate token count. Avoids tiktoken dependency.
 * Rough estimate: 1 token ≈ 4 characters for English text.
 * Applies a 15% safety margin to guard against estimation error.
 * Images and files get fixed estimates.
 */
export const estimateTokens = (messages: ModelMessage[]): number => charsToTokens(estimateChars(messages));

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
 * Where the kept tail may start, as an index into `conversation` (the non-system
 * messages). Returns -1 when there is no such index above 0.
 *
 * - At least `keep` messages from the end, when possible.
 * - Never after the latest user turn, so that turn stays whole.
 * - On an assistant message. Tool results follow their call, so a tail that
 *   starts there never orphans a result. And the summary that replaces the
 *   older messages is a user message, which must not sit beside another one.
 */
const findRecentStart = (conversation: ModelMessage[], keep: number): number => {
    let latestUser = -1;

    for (let i = conversation.length - 1; i >= 0; i -= 1) {
        if (conversation[i]?.role === "user") {
            latestUser = i;
            break;
        }
    }

    if (latestUser < 0) {
        return -1;
    }

    for (let i = Math.min(conversation.length - keep, latestUser); i > 0; i -= 1) {
        if (conversation[i]?.role === "assistant") {
            return i;
        }
    }

    return -1;
};

/**
 * Replaces tool outputs with a short note, oldest first, until the prompt is
 * under `threshold` tokens. The final tool message is kept, since the model is
 * reacting to it now. An output no longer than the note is kept too: eliding it
 * would save nothing. Each call keeps its id and name, so every result still
 * answers its call. Returns the input array when nothing was replaced.
 */
// ponytail: only the final tool message is protected. If that one message alone exceeds the window, nothing more can be elided.
const elideToolOutputs = (messages: ModelMessage[], threshold: number): ModelMessage[] => {
    let lastTool = -1;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === "tool") {
            lastTool = i;
            break;
        }
    }

    // Counted once. Each replacement lowers the count by the characters it saves, which is what a re-count would give.
    let chars = estimateChars(messages);
    const elided = new Map<number, ModelMessage>();

    for (let index = 0; index < lastTool && charsToTokens(chars) >= threshold; index += 1) {
        const message = messages[index];

        if (message?.role !== "tool" || !Array.isArray(message.content)) {
            continue;
        }

        let saved = 0;

        const content = message.content.map((part) => {
            if (part.type !== "tool-result") {
                return part;
            }

            const { length } = toolResultText(part);

            if (length <= ELIDED_TOOL_OUTPUT.length) {
                return part;
            }

            saved += length - ELIDED_TOOL_OUTPUT.length;

            return { ...part, output: { type: "text" as const, value: ELIDED_TOOL_OUTPUT } };
        });

        if (saved > 0) {
            chars -= saved;
            elided.set(index, { ...message, content } as ModelMessage);
        }
    }

    if (elided.size === 0) {
        return messages;
    }

    // One copy of the array, with only the changed messages swapped in.
    return messages.map((m, i) => elided.get(i) ?? m);
};

/** Summary of the messages being dropped, capped at ~20% of the context window. */
const summarizeOlderMessages = (olderMessages: ModelMessage[], contextLimit: number): string => {
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

                    if (p?.type === "tool-result") return `[Result: ${toolResultText(p).slice(0, SUMMARY_TRUNCATION_LENGTH)}]`;

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

    return summaryText;
};

/**
 * Compresses older messages in the conversation to fit within context limits.
 * Keeps system messages and recent exchanges intact, summarizes the rest. If the
 * result is still over the limit, elides older tool outputs (the current turn's
 * included). Compression never splits a tool call from its result.
 *
 * Returns the compressed array, or the original array (same reference) when no
 * compression applies.
 */
export const compressContextMessages = (messages: ModelMessage[], contextLimit: number): ModelMessage[] => {
    const threshold = contextLimit * DEFAULT_AUTO_CONTINUE_CONFIG.compressionThreshold;

    if (estimateTokens(messages) < threshold) {
        return messages; // No compression needed
    }

    const systemMessages = messages.filter((m) => m.role === "system");
    const conversationMessages = messages.filter((m) => m.role !== "system");
    let compressed = messages;

    const cut = findRecentStart(conversationMessages, RECENT_MESSAGES_TO_KEEP);

    if (cut > 0) {
        const olderMessages = conversationMessages.slice(0, cut);
        const recentMessages = conversationMessages.slice(cut);
        // Use "user" role for summary to avoid conflicting with the real system prompt
        const summary = {
            content: `[Context from earlier in this conversation]\n${summarizeOlderMessages(olderMessages, contextLimit)}`,
            role: "user" as const,
        } as unknown as ModelMessage;

        compressed = [...systemMessages, summary, ...recentMessages];

        // Post-compression size check — if the summary still leaves us over, keep a one-line note instead
        if (estimateTokens(compressed) > threshold) {
            const note = { content: DROPPED_SUMMARY_NOTE, role: "user" as const } as unknown as ModelMessage;

            compressed = [...systemMessages, note, ...recentMessages];
        }
    }

    return elideToolOutputs(compressed, threshold);
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

/** The window a prompt must fit when `backupModelId` may serve the call in place of `modelId`: the smaller of the two. */
export const getFallbackContextWindow = (modelId: string, backupModelId?: string): number =>
    backupModelId ? Math.min(getModelContextWindow(modelId), getModelContextWindow(backupModelId)) : getModelContextWindow(modelId);

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
export const applyLateCompression = (messages: ModelMessage[], modelId: string, backupModelId?: string): ModelMessage[] => {
    const contextWindow = getFallbackContextWindow(modelId, backupModelId);
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
 * Keeps only system messages + the last 4 messages (cut where `findRecentStart`
 * allows), with minimal summaries.
 */
const aggressiveCompressMessages = (messages: ModelMessage[], contextLimit: number): ModelMessage[] => {
    const AGGRESSIVE_RECENT_KEEP = 4;

    const systemMessages = messages.filter((m) => m.role === "system");
    const conversationMessages = messages.filter((m) => m.role !== "system");
    const cut = findRecentStart(conversationMessages, AGGRESSIVE_RECENT_KEEP);

    if (cut <= 0) {
        return messages;
    }

    const AGGRESSIVE_SUMMARY_LENGTH = 100;

    const recentMessages = conversationMessages.slice(cut);
    const olderMessages = conversationMessages.slice(0, cut);

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
