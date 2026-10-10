/**
 * Multi-key pool rotation for provider API keys.
 *
 * Distributes load across a pool of API keys per provider.
 * Tracks RPM counts per key in KV and cools down exhausted keys
 * (those that received a 429) for 30 seconds.
 *
 * KV key schema:
 *   pool:{provider}:{model}:{keyIndex}:rpm      — rolling RPM count (1-min window)
 *   pool:{provider}:{model}:{keyIndex}:cooldown — present when key is rate-limited (30s TTL)
 */

import type { LanguageModel } from "ai";

import { createProviderModel } from "./factory.js";

/** TTL for cooldown marker when a key receives a 429 (seconds) */
const COOLDOWN_TTL_S = 30;
/** Sliding window for RPM tracking (seconds) */
const RPM_WINDOW_TTL_S = 60;

export interface KeySelection {
    index: number;
    key: string;
}

const cooldownKey = (provider: string, modelApiId: string, index: number): string => `pool:${provider}:${modelApiId}:${index}:cooldown`;

const rpmKey = (provider: string, modelApiId: string, index: number): string => `pool:${provider}:${modelApiId}:${index}:rpm`;

/**
 * Count active tick entries for a key in the rolling window.
 * KV `list` is eventually consistent but accurate enough for load-balancing.
 */
const readRpm = async (kv: KVNamespace, provider: string, modelApiId: string, index: number): Promise<number> => {
    try {
        const result = await kv.list({ limit: 1000, prefix: `${rpmKey(provider, modelApiId, index)}:tick:` });

        return result.keys.length;
    } catch {
        return 0;
    }
};

/**
 * KeyPoolManager manages a pool of API keys for a provider.
 * Uses KV to track per-key cooldown and RPM state.
 */
export class KeyPoolManager {
    private kv: KVNamespace;

    private provider: string;

    private modelApiId: string;

    private keys: string[];

    constructor(kv: KVNamespace, provider: string, modelApiId: string, keys: string[]) {
        if (keys.length === 0) {
            throw new Error(`KeyPoolManager: no keys provided for ${provider}/${modelApiId}`);
        }

        this.kv = kv;
        this.provider = provider;
        this.modelApiId = modelApiId;
        this.keys = keys;
    }

    /** Number of keys in the pool. */
    get size(): number {
        return this.keys.length;
    }

    /** Select the best key: least-busy among healthy keys, or earliest-expiry key if all are cooling down. */
    async selectKey(): Promise<KeySelection> {
        if (this.keys.length === 1) {
            return { index: 0, key: this.keys[0]! };
        }

        // Load state for all keys in parallel
        const states = await Promise.all(
            this.keys.map(async (key, index) => {
                const [cooldown, rpm] = await Promise.all([
                    this.kv.get(cooldownKey(this.provider, this.modelApiId, index)),
                    readRpm(this.kv, this.provider, this.modelApiId, index),
                ]);

                return {
                    coolingDown: cooldown !== null,
                    index,
                    key,
                    rpm,
                };
            }),
        );

        // Among healthy (non-cooling) keys, pick the one with lowest RPM
        const healthy = states.filter((s) => !s.coolingDown);

        if (healthy.length > 0) {
            healthy.sort((a, b) => a.rpm - b.rpm);
            const selected = healthy[0]!;

            return { index: selected.index, key: selected.key };
        }

        // All keys are cooling down — pick the one with the lowest remaining TTL
        // by falling back to round-robin on the index with smallest index as tie-breaker
        // (we can't easily get remaining TTL from Cloudflare KV metadata without extra calls)
        const fallback = states[0]!;

        return { index: fallback.index, key: fallback.key };
    }

    /**
     * Record one RPM tick for a key.
     *
     * KV has no atomic increment, so the previous get+put pattern lost writes
     * under concurrent traffic — exactly the case the pool exists to handle.
     * Instead we write a unique tick entry per request (sub-key by timestamp +
     * random suffix) with a 60s TTL. `selectKey` counts tick keys via `list`
     * to derive the rolling RPM, which is concurrency-safe at the cost of
     * one extra KV list per selection.
     *
     * Non-blocking — call with waitUntil if you don't want to await.
     */
    async recordUsage(index: number): Promise<void> {
        try {
            const tickKey = `${rpmKey(this.provider, this.modelApiId, index)}:tick:${Date.now()}:${crypto.randomUUID().slice(0, 6)}`;

            await this.kv.put(tickKey, "1", { expirationTtl: RPM_WINDOW_TTL_S });
        } catch {
            // Non-critical — don't fail the request
        }
    }

    /**
     * Mark a key as cooling down for COOLDOWN_TTL_S seconds.
     * Call this when the provider returns a 429 for this key.
     */
    async recordRateLimit(index: number): Promise<void> {
        try {
            await this.kv.put(cooldownKey(this.provider, this.modelApiId, index), "1", { expirationTtl: COOLDOWN_TTL_S });
        } catch {
            // Non-critical
        }
    }

    /**
     * Execute an AI SDK call with automatic key rotation on 429.
     *
     * Tries each available key in order of ascending RPM. If a key returns 429,
     * marks it as cooling down and retries with the next healthy key. Throws
     * after exhausting all keys.
     */
    async withModel<T>(function_: (model: LanguageModel) => Promise<T>): Promise<T> {
        // We try up to `keys.length` times, rotating through the pool
        let lastError: unknown;

        for (let attempt = 0; attempt < this.keys.length; attempt++) {
            const { index, key } = await this.selectKey();

            try {
                const model = await createProviderModel(this.provider, this.modelApiId, key);
                const result = await function_(model);

                // Record successful use (non-blocking, best-effort)
                this.recordUsage(index).catch(() => {});

                return result;
            } catch (error) {
                lastError = error;

                if (is429Error(error)) {
                    // Cool down this key and try the next one
                    await this.recordRateLimit(index);
                    continue;
                }

                // Non-429 error — propagate immediately
                throw error;
            }
        }

        throw lastError;
    }
}

/**
 * Detect whether an error from an AI SDK provider is a 429 rate-limit response.
 *
 * Substring matches on "429" produced false positives (e.g. "model returned
 * 429 tokens"), so we require either a structured status code or a recognised
 * AI SDK error name. Cause-chain walks handle wrapped errors.
 */
const RATE_LIMIT_ERROR_NAMES = new Set(["AI_APIRateLimitError", "AI_RateLimitError", "RateLimitError"]);

/** Standalone 429 in a message. Word-bounded so `1429` / `4290` don't match. */
const STATUS_429 = /\b429\b/;

/** The error fields {@link is429Error} probes for a rate-limit signal. */
interface RateLimitErrorShape {
    cause?: unknown;
    message?: unknown;
    name?: unknown;
    responseBody?: unknown;
    status?: unknown;
    statusCode?: unknown;
}

export const is429Error = (error: unknown, depth = 0): boolean => {
    if (!error || typeof error !== "object" || depth > 5) return false;

    const record = error as RateLimitErrorShape;

    if (record["statusCode"] === 429 || record["status"] === 429) return true;

    if (typeof record["name"] === "string" && RATE_LIMIT_ERROR_NAMES.has(record["name"])) return true;

    // AI SDK responseBody exposes `error.code` for OpenAI-compatible providers.
    const { responseBody } = record;

    if (responseBody && typeof responseBody === "object") {
        const inner = (responseBody as { error?: unknown })["error"];

        if (inner && typeof inner === "object") {
            const { code } = inner as { code?: unknown };

            if (code === "rate_limit_exceeded" || code === 429) return true;
        }
    }

    // Some providers only surface the status in the message text.
    if (typeof record["message"] === "string" && STATUS_429.test(record["message"])) return true;

    if (record["cause"] !== undefined) {
        return is429Error(record["cause"], depth + 1);
    }

    return false;
};

/**
 * Parse a comma-separated list of API keys from a string.
 * Trims whitespace and filters empty entries.
 */
export const parseKeyList = (raw: string): string[] =>
    raw
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
