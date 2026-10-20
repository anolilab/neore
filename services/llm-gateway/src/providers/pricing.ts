/**
 * Model pricing database via models.dev.
 *
 * Fetches up-to-date pricing from the community-maintained models.dev API,
 * caches in KV with 24h TTL. Falls back to last cached data when unavailable.
 */
import type { AppEnv } from "../env.js";
import { isMockLlmEnabled, MOCK_PRICING } from "./mock-model.js";

export interface ModelPricing {
    cachedInputPerMillion?: number;
    contextWindow?: number;
    inputPerMillion: number;
    outputPerMillion: number;
    reasoningOutputPerMillion?: number;
}

export interface TokenUsage {
    cachedTokens?: number;
    completionTokens: number;
    promptTokens: number;
    reasoningTokens?: number;
}

/** The models.dev model fields this module reads. `cost` is USD per million tokens. */
interface ModelsDevelopmentModel {
    cost?: { cache_read?: number; cache_write?: number; input?: number; output?: number; reasoning?: number };
    id?: string;
    limit?: { context?: number; output?: number };
}

interface ModelsDevelopmentProvider {
    id?: string;
    models?: Record<string, ModelsDevelopmentModel>;
}

/** models.dev is keyed by provider id; each provider holds its models keyed by model id. */
export type ModelsDevelopmentData = Record<string, ModelsDevelopmentProvider>;

const MODELS_DEV_URL = "https://models.dev/api.json";
/** The whole models.dev document, provider-keyed (`data[provider].models[model]`). */
const FULL_CACHE_KEY = "models_dev_full";
const FULL_CACHE_TTL = 86_400; // 24 hours
// v2: entries written before the provider-keyed lookup may carry the old (x 1e6) scale.
const PRICING_KEY_PREFIX = "pricing:v2:";
const PRICING_TTL = 86_400;

/**
 * Calculate cost in microdollars from token usage and pricing.
 * $1.00 = 1,000,000 microdollars.
 */
export const calculateCost = (pricing: ModelPricing, usage: TokenUsage): number => {
    const regularInputTokens = usage.promptTokens - (usage.cachedTokens ?? 0);
    const inputCost = (regularInputTokens * pricing.inputPerMillion) / 1_000_000;
    const outputCost = (usage.completionTokens * pricing.outputPerMillion) / 1_000_000;
    const cachedCost = ((usage.cachedTokens ?? 0) * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion)) / 1_000_000;
    const reasoningCost = ((usage.reasoningTokens ?? 0) * (pricing.reasoningOutputPerMillion ?? pricing.outputPerMillion)) / 1_000_000;

    // Convert dollars to microdollars
    return Math.round((inputCost + outputCost + cachedCost + reasoningCost) * 1_000_000);
};

/** Fetches with a 5s timeout to avoid blocking requests when models.dev is slow. */
const fetchWithTimeout = async (url: string): Promise<ModelsDevelopmentData | null> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
        const response = await fetch(url, { signal: controller.signal });

        if (!response.ok) {
            await response.body?.cancel();

            return null;
        }

        return (await response.json()) as ModelsDevelopmentData;
    } finally {
        clearTimeout(timeoutId);
    }
};

/** Reads the full models.dev payload from KV, fetching (and caching) it on a cold start. */
const getFullData = async (kv: KVNamespace): Promise<ModelsDevelopmentData | null> => {
    const cached = await kv.get(FULL_CACHE_KEY, "json");

    if (cached) {
        return cached as ModelsDevelopmentData;
    }

    // Cold start: fetch from models.dev
    try {
        const data = await fetchWithTimeout(MODELS_DEV_URL);

        if (!data) {
            return null;
        }

        await kv.put(FULL_CACHE_KEY, JSON.stringify(data), { expirationTtl: FULL_CACHE_TTL });

        return data;
    } catch {
        return null;
    }
};

/** Strips trailing `/` and `:` separators without the backtracking a `[/:]+$` regex would incur. */
const stripTrailingSeparators = (value: string): string => {
    let end = value.length;

    while (end > 0 && (value[end - 1] === "/" || value[end - 1] === ":")) {
        end--;
    }

    return value.slice(0, end);
};

/** Maps a models.dev model to our pricing, or `null` when it carries no usable price. */
const toPricing = (model: ModelsDevelopmentModel | undefined): ModelPricing | null => {
    const cost = model?.cost;

    if (!cost || (!cost.input && !cost.output)) {
        return null;
    }

    return {
        ...(cost.cache_read !== undefined && { cachedInputPerMillion: cost.cache_read }),
        ...(model.limit?.context !== undefined && { contextWindow: model.limit.context }),
        inputPerMillion: cost.input ?? 0,
        outputPerMillion: cost.output ?? 0,
        ...(cost.reasoning !== undefined && { reasoningOutputPerMillion: cost.reasoning }),
    };
};

/** The first model in `models` that carries a usable price, mapped. */
const firstPriced = (models: (ModelsDevelopmentModel | undefined)[]): ModelPricing | null => {
    for (const model of models) {
        const pricing = toPricing(model);

        if (pricing) {
            return pricing;
        }
    }

    return null;
};

/** The first `/` or `:` in a model id, which separates a provider prefix. */
const PROVIDER_SEPARATOR = /[/:]/;

/**
 * Extract pricing from the models.dev document, which is keyed by provider
 * (`data[provider].models[model]`). The model id may be bare (`gpt-5`),
 * provider-prefixed (`anthropic/claude-sonnet-4-5`, `anthropic:claude-sonnet-4-5`)
 * or an OpenRouter-style id (`meta-llama/llama-4-scout`). The hinted provider is
 * tried first, then every provider; entries without a price are skipped, because
 * resellers list many models without one.
 */
export const extractPricing = (data: ModelsDevelopmentData, modelApiId: string, providerHint?: string): ModelPricing | null => {
    // Normalise: strip trailing slashes/colons that would otherwise produce
    // an empty base id and match every key with a separator.
    const normalisedId = stripTrailingSeparators(modelApiId);

    if (!normalisedId) {
        return null;
    }

    const separator = normalisedId.search(PROVIDER_SEPARATOR);
    const prefix = separator > 0 ? normalisedId.slice(0, separator) : undefined;
    const afterPrefix = separator > 0 ? normalisedId.slice(separator + 1) : undefined;
    const baseId = normalisedId.slice(normalisedId.lastIndexOf("/") + 1);

    const candidates = [...new Set([normalisedId, afterPrefix, baseId].filter((id): id is string => Boolean(id)))];
    const hints = [...new Set([providerHint, prefix].filter((hint): hint is string => Boolean(hint)))];
    const providers = Object.values(data);

    return (
        firstPriced(hints.flatMap((hint) => candidates.map((candidate) => data[hint]?.models?.[candidate]))) ??
        firstPriced(candidates.flatMap((candidate) => providers.map((provider) => provider.models?.[candidate]))) ??
        // Suffix match (e.g. "llama-4-scout" -> "meta-llama/llama-4-scout").
        firstPriced(
            providers.flatMap((provider) =>
                Object.entries(provider.models ?? {})
                    .filter(([key]) => key === baseId || key.endsWith(`/${baseId}`))
                    .map(([, model]) => model),
            ),
        )
    );
};

export class PricingService {
    private kv: KVNamespace;

    private mock: boolean;

    constructor(env: AppEnv) {
        this.kv = env.PRICING_KV;
        this.mock = isMockLlmEnabled(env);
    }

    /**
     * Get pricing for a specific model. `providerHint` is the gateway provider id
     * (e.g. "anthropic"), tried first in the provider-keyed models.dev document.
     * Checks KV cache first, then fetches from models.dev if needed.
     */
    async getPricing(modelApiId: string, providerHint?: string): Promise<ModelPricing | null> {
        // Every model is the mock then, so it is priced as one — deterministic,
        // and no models.dev fetch in an offline e2e run.
        if (this.mock) {
            return MOCK_PRICING;
        }

        // Check per-model KV cache
        const cacheKey = `${PRICING_KEY_PREFIX}${modelApiId}`;
        const cached = await this.kv.get(cacheKey, "json");

        if (cached) {
            return cached as ModelPricing;
        }

        // Try to get from full cached data
        const fullData = await getFullData(this.kv);

        if (!fullData) {
            return null;
        }

        const pricing = extractPricing(fullData, modelApiId, providerHint);

        if (pricing) {
            await this.kv.put(cacheKey, JSON.stringify(pricing), { expirationTtl: PRICING_TTL });
        }

        return pricing;
    }

    /**
     * Refresh all pricing data from models.dev (called by scheduled cron, daily).
     */
    async refreshAll(): Promise<void> {
        try {
            const data = await fetchWithTimeout(MODELS_DEV_URL);

            if (data) {
                await this.kv.put(FULL_CACHE_KEY, JSON.stringify(data), { expirationTtl: FULL_CACHE_TTL });
            }
        } catch {
            // Silent failure — keep serving from existing cache
        }
    }
}
