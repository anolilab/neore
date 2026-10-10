import type { JSONObject } from "@ai-sdk/provider";

/**
 * Per-attempt provider options filter.
 *
 * `providerOptions` is keyed by provider name (e.g. `anthropic`, `openai`).
 * When the gateway falls back across providers, options addressed to the
 * original provider must NOT be passed to the new one — most providers
 * reject unknown keys with HTTP 400 and our health tracker would mark them
 * unhealthy for what is really a payload-shaping mistake.
 *
 * `filterProviderOptions(options, provider)` returns a copy of the input
 * with:
 *   - The active provider's bucket retained (intersected with a per-provider
 *     allowlist of supported keys), so cross-provider parameter clobber
 *     can't leak (e.g. an Anthropic-only `thinking` key bouncing into
 *     OpenAI).
 *   - All other provider buckets dropped.
 *
 * The function is also called in the streaming/generate hot path, so it
 * does no allocation when the input is already empty.
 */

/** `providerOptions` as the AI SDK models it: provider name -> option bucket. */
export type ProviderOptionsMap = Record<string, JSONObject>;

/** Per-provider allowlist of keys we forward to the underlying SDK. */
const PROVIDER_OPTION_ALLOWLISTS: Record<string, ReadonlySet<string>> = {
    anthropic: new Set(["cacheControl", "disableParallelToolUse", "sendReasoning", "thinking", "topK"]),
    cloudflare: new Set(["safe_prompt"]),
    fal: new Set(["guidanceScale", "numInferenceSteps", "safetyTolerance"]),
    google: new Set(["cachedContent", "responseModalities", "safetySettings", "structuredOutputs", "thinkingConfig", "useSearchGrounding"]),
    groq: new Set(["reasoningFormat", "topK", "user"]),
    openai: new Set([
        "logprobs",
        "metadata",
        "parallelToolCalls",
        "reasoningEffort",
        "reasoningSummary",
        "serviceTier",
        "store",
        "structuredOutputs",
        "topLogprobs",
        "user",
    ]),
    openrouter: new Set(["minP", "models", "provider", "reasoning", "repetitionPenalty", "route", "topA", "topK", "transforms"]),
    requesty: new Set(["metadata", "user"]),
    xai: new Set(["reasoningEffort", "user"]),
};

/**
 * Strip provider-specific keys from `providerOptions` that don't apply to
 * the active provider, and intersect the remaining keys with the provider's
 * allowlist.
 *
 * Returns `undefined` when the result would be empty so callers can skip
 * passing the parameter to streamText/generateText entirely.
 */
export const filterProviderOptions = (options: ProviderOptionsMap | undefined, provider: string): ProviderOptionsMap | undefined => {
    if (!options || Object.keys(options).length === 0) {
        return undefined;
    }

    const providerBucket = options[provider];

    if (!providerBucket || typeof providerBucket !== "object" || Array.isArray(providerBucket)) {
        return undefined;
    }

    const allowed = PROVIDER_OPTION_ALLOWLISTS[provider];
    const filtered: JSONObject = {};

    for (const [key, value] of Object.entries(providerBucket)) {
        if (!allowed || allowed.has(key)) {
            filtered[key] = value;
        }
    }

    if (Object.keys(filtered).length === 0) {
        return undefined;
    }

    return { [provider]: filtered };
};

/**
 * Reasoning-only models that reject `temperature` / `topP` and require
 * `maxCompletionTokens` instead of `maxTokens`. Used by callers to suppress
 * the offending parameters before they hit the SDK.
 */
const REASONING_ONLY_MODEL_PREFIXES = ["o1", "o3", "o4", "gpt-5"];

export const isReasoningOnlyModel = (modelApiId: string): boolean => {
    const lower = modelApiId.toLowerCase();

    return REASONING_ONLY_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix) || lower.includes(`/${prefix}`));
};

/**
 * Filter top-level call parameters (temperature, maxTokens) per the active
 * model's tolerance. Returns a partial overlay to merge into the call args.
 */
export const filterCallParameters = (
    params: { maxOutputTokens?: number; temperature?: number; topP?: number },
    modelApiId: string,
): { maxOutputTokens?: number; temperature?: number; topP?: number } => {
    if (!isReasoningOnlyModel(modelApiId)) {
        return params;
    }

    // Reasoning-only models reject temperature/topP; pass through max tokens.
    return params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens };
};

/**
 * Provider option keys that only mean anything on a model that actually runs
 * a reasoning/thinking pass.
 *
 * These are composed for whichever model the caller *thought* it was talking
 * to. Routing is free to move the request to a different model in the same
 * provider — a downgrade from a thinking model to a fast one stays inside
 * `anthropic` or `google` and so survives {@link filterProviderOptions}
 * untouched — at which point the surviving `thinking` / `reasoningEffort` key
 * is a hard 400 from the provider, and the health tracker books it against
 * the model rather than against the payload.
 */
const REASONING_ONLY_OPTION_KEYS: ReadonlySet<string> = new Set([
    "reasoning",
    "reasoningEffort",
    "reasoningFormat",
    "reasoningSummary",
    "sendReasoning",
    "thinking",
    "thinkingConfig",
]);

/**
 * Drop reasoning-only keys when the target model is known not to support them.
 *
 * Only strips on an explicit `false`. An unknown capability (`undefined`) is
 * left alone: stripping on a guess would silently disable thinking on models
 * whose metadata simply has not been filled in yet, which is a worse failure
 * than the 400 this exists to prevent.
 */
export const stripReasoningOptions = (
    options: Record<string, unknown> | undefined,
    supportsReasoning: boolean | undefined,
): Record<string, unknown> | undefined => {
    if (!options || supportsReasoning !== false) {
        return options;
    }

    const kept = Object.fromEntries(Object.entries(options).filter(([key]) => !REASONING_ONLY_OPTION_KEYS.has(key)));

    return Object.keys(kept).length > 0 ? kept : undefined;
};
