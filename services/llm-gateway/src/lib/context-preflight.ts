/**
 * Context window pre-flight check.
 *
 * Runs before sending a request to a provider to catch context-overflow
 * situations early. Three possible outcomes:
 *
 *   1. `ok`         — within limits, proceed normally.
 *   2. `compressed` — middle-out compression was applied; use `messages`.
 *   3. `overflow`   — cannot fit; caller should return 413.
 */
import type { EstimatorMessage } from "./token-estimator.js";
import { applyMiddleOut, estimateTokens } from "./token-estimator.js";

export type PreflightOutcome =
    | { status: "ok" }
    | {
          compressedTokens: number;
          messages: EstimatorMessage[];
          originalTokens: number;
          status: "compressed";
      }
    | {
          contextWindow: number;
          estimatedTokens: number;
          status: "overflow";
      };

/**
 * Run a context window pre-flight check.
 * @param messages Conversation messages (not including system prompt).
 * @param contextWindow The model's context window in tokens (0 = skip check).
 * @param system Optional system prompt text.
 * @param transforms Optional transform list (e.g. `['middle-out']`).
 */
export const contextPreflight = (messages: EstimatorMessage[], contextWindow: number | undefined, system?: string, transforms?: string[]): PreflightOutcome => {
    // No context window info — skip check
    if (!contextWindow || contextWindow <= 0) return { status: "ok" };

    const estimate = estimateTokens(messages, contextWindow, system);

    if (estimate.withinLimit) return { status: "ok" };

    // Try middle-out compression if requested
    if (transforms?.includes("middle-out")) {
        const result = applyMiddleOut(messages, contextWindow, 3, system);

        if (result.compressed) {
            return {
                compressedTokens: result.compressedTokens,
                messages: result.messages,
                originalTokens: result.originalTokens,
                status: "compressed",
            };
        }
    }

    // Cannot fit — overflow
    return {
        contextWindow,
        estimatedTokens: estimate.estimatedTokens,
        status: "overflow",
    };
};
