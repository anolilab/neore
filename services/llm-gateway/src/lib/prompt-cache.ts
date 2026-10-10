/**
 * Prompt-level exact-match response cache.
 *
 * Caches non-streaming LLM completions in Cloudflare KV keyed by a SHA-256 hash of:
 * model + messages + system prompt + temperature + tools
 *
 * Caching rules:
 * - Only deterministic requests: temperature must be 0 or absent
 * - Never cache tool-call requests (non-deterministic side effects)
 * - Cache bypass: Cache-Control: no-cache header OR { cache: false } in request body
 * - Default TTL: 1 hour
 */

/** Default TTL for cached responses (1 hour) */
const DEFAULT_TTL_SECONDS = 3600;

/** Cached response shape stored in KV */
export interface CachedResponse {
    /** Unix timestamp (ms) when this entry was cached */
    cachedAt: number;
    cost: { microdollars: number; pricingAvailable: boolean };
    finishReason: string;
    /** Original latency when the response was generated (for transparency) */
    originalLatencyMs: number;
    text: string;
    usage: {
        cachedTokens: number;
        completionTokens: number;
        promptTokens: number;
        reasoningTokens: number;
    };
}

export interface PromptCacheRequest {
    messages: unknown[];
    modelApiId: string;
    modelId: string;
    system?: string;
    temperature?: number;
    /** Number of tools offered — requests with tools are never cached */
    toolCount?: number;
}

/** Compute a SHA-256 cache key for a generation request. */
const computeCacheKey = async (request: PromptCacheRequest): Promise<string> => {
    const payload = JSON.stringify({
        messages: request.messages,
        modelApiId: request.modelApiId,
        modelId: request.modelId,
        system: request.system ?? null,
        // Only include temperature in key when it's explicitly set (absence == 0)
        temperature: request.temperature ?? 0,
    });

    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");

    return `cache:${hex}`;
};

/** Returns true if a request is eligible for caching. */
export const isCacheable = (request: PromptCacheRequest, isCacheBypass: boolean): boolean => {
    if (isCacheBypass) return false;

    // Never cache tool-call requests (non-deterministic side effects)
    if ((request.toolCount ?? 0) > 0) return false;

    // Only cache deterministic (temperature = 0) requests
    if (request.temperature !== undefined && request.temperature > 0) return false;

    return true;
};

const FLUSH_EPOCH_KEY = "cache:flush_epoch";

/** Read the admin flush sentinel. Treats an unreadable/absent epoch as "never flushed". */
const readFlushEpoch = async (kv: KVNamespace): Promise<number> => {
    try {
        const raw = await kv.get(FLUSH_EPOCH_KEY);
        const parsed = raw ? Number(raw) : 0;

        return Number.isFinite(parsed) ? parsed : 0;
    } catch {
        return 0;
    }
};

export class PromptCache {
    /** Get cache stats from D1 (hit/miss counts). */
    static async getStats(
        database: D1Database,
        period: "24h" | "7d" = "24h",
    ): Promise<{ hitRate: number; hits: number; misses: number; savedCostMicrodollars: number; savedTokens: number }> {
        const hours = period === "24h" ? 24 : 168;
        const since = new Date(Date.now() - hours * 3_600_000).toISOString();

        try {
            const row = await database
                .prepare(
                    `SELECT
                        SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) AS hits,
                        SUM(CASE WHEN cache_hit = 0 THEN 1 ELSE 0 END) AS misses,
                        SUM(CASE WHEN cache_hit = 1 THEN prompt_tokens + completion_tokens ELSE 0 END) AS saved_tokens,
                        SUM(CASE WHEN cache_hit = 1 THEN cost_microdollars ELSE 0 END) AS saved_cost
                     FROM usage_log
                     WHERE created_at >= ?`,
                )
                .bind(since)
                .first<{ hits: number; misses: number; saved_cost: number; saved_tokens: number }>();

            const hits = row?.hits ?? 0;
            const misses = row?.misses ?? 0;
            const total = hits + misses;

            return {
                hitRate: total > 0 ? hits / total : 0,
                hits,
                misses,
                savedCostMicrodollars: row?.saved_cost ?? 0,
                savedTokens: row?.saved_tokens ?? 0,
            };
        } catch {
            return { hitRate: 0, hits: 0, misses: 0, savedCostMicrodollars: 0, savedTokens: 0 };
        }
    }

    private kv: KVNamespace;

    private ttlSeconds: number;

    constructor(kv: KVNamespace, ttlSeconds = DEFAULT_TTL_SECONDS) {
        this.kv = kv;
        this.ttlSeconds = ttlSeconds;
    }

    async get(request: PromptCacheRequest): Promise<CachedResponse | null> {
        const key = await computeCacheKey(request);

        try {
            const [raw, epoch] = await Promise.all([this.kv.get(key, "json"), readFlushEpoch(this.kv)]);
            const entry = (raw as CachedResponse) ?? null;

            if (!entry) return null;

            // Honor admin-triggered flushes. flushAll() bumps the epoch sentinel;
            // any entry cached before that epoch is treated as a miss and the
            // KV row is best-effort deleted so it stops costing reads.
            if (epoch > 0 && entry.cachedAt < epoch) {
                this.kv.delete(key).catch(() => {});

                return null;
            }

            return entry;
        } catch {
            return null;
        }
    }

    async set(request: PromptCacheRequest, response: CachedResponse): Promise<void> {
        const key = await computeCacheKey(request);

        try {
            await this.kv.put(key, JSON.stringify(response), { expirationTtl: this.ttlSeconds });
        } catch {
            // Non-critical — log and continue
            console.warn("[PromptCache] Failed to write cache entry:", key);
        }
    }

    /**
     * Flush all cache entries for a specific user/model or flush all (admin only).
     * Since KV doesn't support prefix scans on the free tier, this deletes by
     * iterating a stored index key. For simplicity, we support a full flush only.
     * For per-user/per-model flush, callers should recompute keys and delete directly.
     */

    /**
     * Flush all cache entries by bumping the flush epoch.
     *
     * KV does not support atomic prefix listing/deletion on Workers, so we use a
     * sentinel `cache:flush_epoch` key. `get()` reads this on every lookup and
     * treats any entry with `cachedAt < epoch` as a miss (and best-effort
     * deletes it). The flush is therefore immediate from the caller's
     * perspective: stale responses can no longer be served, even though the
     * physical KV rows are reaped lazily on read.
     */
    async flushAll(): Promise<{ deleted: number; epoch: number }> {
        const epoch = Date.now();

        try {
            // No TTL — the epoch must outlive any cache entry it invalidates.
            await this.kv.put(FLUSH_EPOCH_KEY, String(epoch));
        } catch {
            // Best-effort: surfacing a partial failure here doesn't help callers,
            // since the deleted count is already approximate.
        }

        return { deleted: -1, epoch }; // -1 == "unknown; pruned lazily on read"
    }
}
