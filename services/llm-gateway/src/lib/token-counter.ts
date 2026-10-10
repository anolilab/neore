/**
 * Extract actual token counts from AI SDK v6 provider response metadata.
 *
 * AI SDK v6 uses LanguageModelUsage with:
 *   inputTokens, outputTokens, inputTokenDetails.cacheReadTokens,
 *   outputTokenDetails.reasoningTokens
 */
import type { LanguageModelUsage } from "ai";

export interface TokenCounts {
    cachedTokens: number;
    completionTokens: number;
    promptTokens: number;
    reasoningTokens: number;
}

/**
 * Extract token counts from AI SDK v6 usage metadata.
 */
export const extractTokenCounts = (usage: Partial<LanguageModelUsage> | undefined): TokenCounts => {
    if (!usage) {
        return { cachedTokens: 0, completionTokens: 0, promptTokens: 0, reasoningTokens: 0 };
    }

    return {
        cachedTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
        completionTokens: usage.outputTokens ?? 0,
        promptTokens: usage.inputTokens ?? 0,
        reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
    };
};
