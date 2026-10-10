/**
 * Typed fallback chain classification and model selection.
 *
 * Three distinct fallback categories (mirroring LiteLLM):
 *   - infra:            5xx / 429 / timeout — any healthy model in same tier
 *   - content_policy:   400 refusal — permissive open-source model
 *   - context_overflow: 400/413 token overflow — model with larger context window
 */
import type { ProviderHealthService } from "../providers/health.js";
import type { ModelCandidate } from "./selector.js";

export type FallbackReason = "infra" | "content_policy" | "context_overflow";

/** Lowercase keywords that indicate a content-policy refusal in the provider response body. */
const CONTENT_POLICY_KEYWORDS = [
    "content_policy",
    "content policy",
    "safety",
    "moderation",
    "refuse",
    "refusal",
    "harm",
    "harmful",
    "policy violation",
    "inappropriate",
    "offensive",
    "violat",
    "blocked",
    "not allowed",
];

/**
 * Model IDs (in priority order) to use for content-policy fallbacks.
 * These are permissive open-source models that are less likely to refuse.
 */
export const CONTENT_POLICY_FALLBACK_MODELS = ["mistral-nemo", "llama-4-scout"] as const;

/**
 * Minimum context window (tokens) required for a context-overflow fallback model.
 * Also, the fallback must have contextWindow >= 2x the failed model's window.
 */
const CONTEXT_FALLBACK_MIN_WINDOW = 500_000;

/**
 * Classify why a provider call failed and determine the appropriate fallback type.
 * @param statusCode HTTP status code from the provider error.
 * @param body Response body text from the provider error (may be empty).
 * @param promptTokens Estimated prompt token count for this request.
 * @param contextWindow Context window of the model that failed (tokens).
 */
export const classifyFailure = (statusCode: number, body: string, promptTokens: number, contextWindow: number | undefined): FallbackReason => {
    // Context overflow: explicit 413 from provider
    if (statusCode === 413) {
        return "context_overflow";
    }

    if (statusCode === 400) {
        const lower = body.toLowerCase();

        // Content-policy refusal: 400 + refusal keywords
        if (CONTENT_POLICY_KEYWORDS.some((k) => lower.includes(k))) {
            return "content_policy";
        }

        // Context overflow: 400 + prompt tokens exceed model limit
        if (contextWindow && promptTokens > contextWindow * 0.95) {
            return "context_overflow";
        }
    }

    // Default: infrastructure failure (5xx, 429, timeout, unknown)
    return "infra";
};

/**
 * Check pre-flight whether a request should skip directly to the context-overflow
 * fallback before even attempting the primary model.
 *
 * Returns true when `promptTokens > contextWindow * 0.95`.
 */
export const shouldPreflightContextFallback = (promptTokens: number, contextWindow: number | undefined): boolean => {
    if (!contextWindow) return false;

    return promptTokens > contextWindow * 0.95;
};

/**
 * Select a fallback model for the given failure reason.
 * @param reason Classified failure reason.
 * @param failedModelId ID of the model that failed (excluded from candidates).
 * @param failedContextWindow Context window of the failed model (used for context_overflow sizing).
 * @param candidates Full candidate pool to select from.
 * @param healthService Used to verify the fallback model is currently healthy.
 * @returns The best available fallback candidate, or null if none is healthy.
 */
export const selectFallback = async (
    reason: FallbackReason,
    failedModelId: string,
    failedContextWindow: number | undefined,
    candidates: ModelCandidate[],
    healthService: ProviderHealthService,
): Promise<ModelCandidate | null> => {
    switch (reason) {
        case "content_policy": {
            // Prefer dedicated permissive models in priority order
            for (const modelId of CONTENT_POLICY_FALLBACK_MODELS) {
                const candidate = candidates.find((c) => c.modelId === modelId && c.modelId !== failedModelId);

                if (candidate) {
                    const healthy = await healthService.isHealthy(candidate.provider, candidate.modelApiId);

                    if (healthy) return candidate;
                }
            }

            return null;
        }

        case "context_overflow": {
            // Must be >= 2x failed model's context window AND >= absolute minimum
            const minWindow = Math.max((failedContextWindow ?? 0) * 2, CONTEXT_FALLBACK_MIN_WINDOW);

            const eligible = candidates
                .filter((c) => c.modelId !== failedModelId && (c.contextWindow ?? 0) >= minWindow)
                // Prefer largest context window first
                .toSorted((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));

            for (const candidate of eligible) {
                const healthy = await healthService.isHealthy(candidate.provider, candidate.modelApiId);

                if (healthy) return candidate;
            }

            return null;
        }

        // "infra" — and any unclassified reason: any healthy model that isn't the failed one
        default: {
            for (const candidate of candidates) {
                if (candidate.modelId === failedModelId) continue;

                const healthy = await healthService.isHealthy(candidate.provider, candidate.modelApiId);

                if (healthy) return candidate;
            }

            return null;
        }
    }
};

/**
 * Extract HTTP status code and body from an AI SDK / provider error.
 * Returns defaults (500, "") when the error doesn't expose them.
 */
export const extractProviderErrorInfo = (error: unknown): { body: string; statusCode: number } => {
    if (error && typeof error === "object") {
        const record = error as { message?: unknown; responseBody?: unknown; statusCode?: unknown };

        // AI SDK APICallError exposes statusCode and responseBody
        const statusCode = typeof record["statusCode"] === "number" ? record["statusCode"] : 500;

        let body = "";

        if (typeof record["responseBody"] === "string") {
            body = record["responseBody"];
        } else if (typeof record["message"] === "string") {
            body = record["message"];
        }

        return { body, statusCode };
    }

    return { body: "", statusCode: 500 };
};
