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

/** Lowercase phrases a provider uses when it rejects a prompt for exceeding the model's context window. */
const CONTEXT_OVERFLOW_KEYWORDS = [
    "context_length_exceeded",
    "context length",
    "context window",
    "prompt is too long",
    "input is too long",
    "too many tokens",
    "maximum number of tokens",
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

        // The provider said so itself: the local token estimate misses tool schemas, images and tokenizer differences.
        if (CONTEXT_OVERFLOW_KEYWORDS.some((k) => lower.includes(k))) {
            return "context_overflow";
        }

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

/** The provider status an error carries, under either field name. */
const readStatus = (error: unknown): number | undefined => {
    if (!error || typeof error !== "object") {
        return undefined;
    }

    const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };

    if (typeof statusCode === "number") {
        return statusCode;
    }

    return typeof status === "number" ? status : undefined;
};

/**
 * Extract HTTP status code and body from an AI SDK / provider error.
 * Returns defaults (500, "") when the error doesn't expose them.
 */
export const extractProviderErrorInfo = (error: unknown): { body: string; statusCode: number } => {
    if (error && typeof error === "object") {
        const record = error as { message?: unknown; responseBody?: unknown };

        // AI SDK APICallError exposes statusCode and responseBody; some SDKs name the status `status`
        const statusCode = readStatus(error) ?? 500;

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

const TRANSIENT_NETWORK_PATTERN =
    /timeout|timed out|econnreset|econnrefused|network|fetch failed|socket hang up|overloaded|unavailable|rate.?limit|too many requests|at capacity/i;

/**
 * The fallback reason to report to a caller that may retry on another model.
 * `classifyFailure` defaults to `infra` for anything it does not recognise;
 * this narrows that to what another model can actually serve: a provider 5xx,
 * 429 or 408, or a timeout / network error carrying no status. A 401, 403, 404,
 * 422, an unrecognised 400 or an internal error (no provider status) gets none.
 */
export const classifyProviderFailure = (error: unknown, promptTokens: number, contextWindow: number | undefined): FallbackReason | undefined => {
    const { body, statusCode } = extractProviderErrorInfo(error);
    const reason = classifyFailure(statusCode, body, promptTokens, contextWindow);

    if (reason !== "infra") {
        return reason;
    }

    const record = error && typeof error === "object" ? (error as { message?: unknown; name?: unknown }) : undefined;

    if (readStatus(error) !== undefined) {
        return statusCode === 429 || statusCode === 408 || statusCode >= 500 ? "infra" : undefined;
    }

    const text = `${typeof record?.name === "string" ? record.name : ""} ${typeof record?.message === "string" ? record.message : ""}`;

    return TRANSIENT_NETWORK_PATTERN.test(text) ? "infra" : undefined;
};

/**
 * Whether a stream part carries something the user would see: text or reasoning with characters in it, a
 * tool call or its argument deltas, a file, or the end of the stream. Until one goes out the caller can
 * still retry the call on another model, whatever structural parts (`text-start`, ...) came first.
 */
export const isVisiblePart = (part: { delta?: unknown; type: string }): boolean => {
    switch (part.type) {
        case "file":
        case "finish":
        case "tool-call": {
            return true;
        }
        case "reasoning-delta":
        case "text-delta":
        case "tool-input-delta": {
            return typeof part.delta === "string" && part.delta.length > 0;
        }
        default: {
            return false;
        }
    }
};
