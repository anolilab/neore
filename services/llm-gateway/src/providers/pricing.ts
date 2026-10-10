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

/** The models.dev entry fields this module reads, keyed by model id. */
interface ModelsDevelopmentEntry {
    context_window?: number;
    pricing?: Record<string, number>;
}

type ModelsDevelopmentData = Record<string, ModelsDevelopmentEntry>;

const MODELS_DEV_URL = "https://models.dev/api.json";
const FULL_CACHE_KEY = "models_dev_full";
const FULL_CACHE_TTL = 86_400; // 24 hours
const PRICING_KEY_PREFIX = "pricing:";
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

/**
 * Extract pricing from the models.dev data structure.
 * The API uses model IDs that may differ from AI SDK IDs —
 * we try multiple lookup strategies to handle OpenRouter-style
 * "provider/model" IDs, colon-separated IDs, and bare model names.
 */
const extractPricing = (data: ModelsDevelopmentData, modelApiId: string): ModelPricing | null => {
    // Normalise: strip trailing slashes/colons that would otherwise produce
    // an empty baseId and match every key with a separator.
    const normalisedId = stripTrailingSeparators(modelApiId);

    if (!normalisedId) {
        return null;
    }

    // Strategy 1: Direct lookup (e.g., "gemini-2.5-flash")
    let model = data[normalisedId];

    // Strategy 2: Strip provider prefix (e.g., "openai/gpt-4o" -> "gpt-4o")
    if (!model && normalisedId.includes("/")) {
        const stripped = normalisedId.split("/").pop();

        if (stripped) {
            model = data[stripped];
        }
    }

    // Strategy 3: Try colon separator (models.dev convention, e.g., "openai:gpt-4o")
    if (!model && normalisedId.includes("/")) {
        model = data[normalisedId.replace("/", ":")];
    }

    // Strategy 4: Fuzzy suffix match (e.g., "meta-llama/llama-4-scout-17b-16e-instruct").
    // Require a non-empty baseId so trailing separators don't degenerate into
    // matching every key with a `/` or `:`.
    if (!model) {
        const baseId = normalisedId.includes("/") ? (normalisedId.split("/").pop() ?? "") : normalisedId;

        if (baseId) {
            const matchKey = Object.keys(data).find((k) => k === baseId || k.endsWith(`/${baseId}`) || k.endsWith(`:${baseId}`));

            if (matchKey) {
                model = data[matchKey];
            }
        }
    }

    if (!model) {
        return null;
    }

    const { pricing } = model;

    if (!pricing) {
        return null;
    }

    return {
        cachedInputPerMillion: pricing["cached_input"] ? pricing["cached_input"] * 1_000_000 : undefined,
        contextWindow: model["context_window"],
        inputPerMillion: (pricing["input"] ?? pricing["prompt"] ?? 0) * 1_000_000,
        outputPerMillion: (pricing["output"] ?? pricing["completion"] ?? 0) * 1_000_000,
        reasoningOutputPerMillion: pricing["reasoning_output"] ? pricing["reasoning_output"] * 1_000_000 : undefined,
    };
};

export class PricingService {
    private kv: KVNamespace;

    private mock: boolean;

    constructor(env: AppEnv) {
        this.kv = env.PRICING_KV;
        this.mock = isMockLlmEnabled(env);
    }

    /**
     * Get pricing for a specific model.
     * Checks KV cache first, then fetches from models.dev if needed.
     */
    async getPricing(modelApiId: string): Promise<ModelPricing | null> {
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

        const pricing = extractPricing(fullData, modelApiId);

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
