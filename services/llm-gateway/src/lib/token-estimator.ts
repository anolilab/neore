/**
 * Token estimation and middle-out compression for context window management.
 *
 * Uses a character-based heuristic (chars / 4) since tiktoken is not
 * available in Cloudflare Workers. Accurate enough for pre-flight checks.
 */

/** A message with a role and string/mixed content. */
export interface EstimatorMessage {
    content: unknown;
    role: string;
}

/** Result of a token estimation call. */
export interface TokenEstimate {
    /** Estimated number of tokens in the prompt. */
    estimatedTokens: number;
    /** How many tokens over the limit (0 when within limit). */
    overflowBy: number;
    /** True when `estimatedTokens &lt;= contextWindow * threshold`. */
    withinLimit: boolean;
}

/** Result of middle-out compression. */
export interface CompressionResult {
    /** True when messages were actually removed. */
    compressed: boolean;
    /** Token estimate after compression. */
    compressedTokens: number;
    /** The compressed message list (ready to send to the provider). */
    messages: EstimatorMessage[];
    /** Token estimate before compression. */
    originalTokens: number;
}

/**
 * Count characters in any message content — handles string content, arrays of parts,
 * or unknown objects (JSON-serialised as a fallback).
 */
const countContentChars = (content: unknown): number => {
    if (typeof content === "string") return content.length;

    if (Array.isArray(content)) {
        let total = 0;

        for (const part of content) {
            if (typeof part === "object" && part !== null) {
                const { text } = part as { text?: unknown };

                total += text && typeof text === "string" ? text.length : JSON.stringify(part).length;
            } else {
                total += String(part).length;
            }
        }

        return total;
    }

    if (content === null || content === undefined) return 0;

    return JSON.stringify(content).length;
};

/**
 * Estimate tokens in a list of messages (plus optional system prompt).
 * Overhead: ~4 tokens per message for role/structure.
 */
export const estimateMessageTokens = (messages: EstimatorMessage[], system?: string): number => {
    const systemTokens = system ? Math.ceil(system.length / 4) + 4 : 0;
    let messageTokens = 0;

    for (const message of messages) {
        // +4 per message for role overhead
        messageTokens += Math.ceil(countContentChars(message.content) / 4) + 4;
    }

    return systemTokens + messageTokens;
};

/**
 * Pre-flight token estimation.
 * @param messages Conversation messages.
 * @param contextWindow Model's maximum context window (tokens).
 * @param system Optional system prompt text.
 * @param threshold Fraction of context window to treat as the soft limit (default 0.95).
 */
export const estimateTokens = (messages: EstimatorMessage[], contextWindow: number, system?: string, threshold = 0.95): TokenEstimate => {
    const estimatedTokens = estimateMessageTokens(messages, system);
    const limit = Math.floor(contextWindow * threshold);
    const isWithinLimit = estimatedTokens <= limit;
    const overflowBy = isWithinLimit ? 0 : estimatedTokens - limit;

    return { estimatedTokens, overflowBy, withinLimit: isWithinLimit };
};

/**
 * Middle-out compression algorithm (OpenRouter-style).
 *
 * Preserves:
 *   - The system message (if present, moved to a separate system field by callers)
 *   - The last `keepPairs` user/assistant pairs
 *
 * Removes the oldest non-system messages from the middle until the estimate
 * fits within `contextWindow * 0.90`.
 *
 * Injects a compression notice into the first retained message or as a new
 * system message if no messages remain after compression.
 * @param messages Full conversation history (no system message; pass separately).
 * @param contextWindow Target context window in tokens.
 * @param keepPairs Number of recent user/assistant pairs to keep (default 3).
 * @param system System prompt text (included in token estimation but not modified).
 */
export const applyMiddleOut = (messages: EstimatorMessage[], contextWindow: number, keepPairs = 3, system?: string): CompressionResult => {
    const originalTokens = estimateMessageTokens(messages, system);
    const target = Math.floor(contextWindow * 0.9);

    if (originalTokens <= target) {
        // No compression needed
        return { compressed: false, compressedTokens: originalTokens, messages, originalTokens };
    }

    // Identify the tail to always preserve (last `keepPairs * 2` non-system messages).
    // We work on the full list; system messages in the list are kept but don't count as pairs.
    const nonSystemIndices: number[] = [];

    for (const [i, message] of messages.entries()) {
        if (message!.role !== "system") {
            nonSystemIndices.push(i);
        }
    }

    // Indices of messages that must be preserved (tail pairs)
    const preservedTailCount = Math.min(keepPairs * 2, nonSystemIndices.length);
    // Middle candidates: non-system, non-tail messages — remove oldest first
    const middleIndices: number[] = nonSystemIndices.slice(0, nonSystemIndices.length - preservedTailCount);

    const removed = new Set<number>();

    for (const index of middleIndices) {
        const current = messages.filter((_, i) => !removed.has(i));
        const estimate = estimateMessageTokens(current, system);

        if (estimate <= target) break;

        removed.add(index);
    }

    const isCompressed = removed.size > 0;
    const resultMessages = messages.filter((_, i) => !removed.has(i));

    // Inject compression notice as a leading user message when messages were removed
    if (isCompressed) {
        const notice: EstimatorMessage = {
            content: "[Note: Earlier conversation history was truncated to fit context window]",
            role: "system",
        };

        resultMessages.unshift(notice);
    }

    const compressedTokens = estimateMessageTokens(resultMessages, system);

    return { compressed: isCompressed, compressedTokens, messages: resultMessages, originalTokens };
};
