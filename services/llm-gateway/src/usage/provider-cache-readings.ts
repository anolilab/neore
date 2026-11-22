/**
 * Provider prompt-cache readings from `usage_log`: how many prompt tokens a provider served from its own cache
 * (`cached_tokens`, the provider's cache reads), by hour and by model. This is the provider's prefix cache, not the
 * gateway's exact-match response cache (`cache_hit`, `lib/prompt-cache.ts`); rows the response cache answered are
 * left out, since no provider saw them.
 *
 * The hourly series counts only the provider/model pairs that reported cached tokens at least once in the last 30 days,
 * so a pair that never caches does not dilute the share, and a pair that stopped caching inside a shorter window still
 * shows its drop. The per-model list is the top 50 by prompt tokens; `all` and `pairs` count every pair, so the
 * window's traffic still shows when no pair cached in 30 days and the list says when it was cut. A drop in the hourly
 * share after a deploy is the reading the prompt-versioning decision waits on (gap-backlog, "Prompt text fixed per
 * thread").
 */
import { sqliteTime } from "../lib/sqlite-time.js";

/** Windows an admin can ask for; raw rows are kept 90 days (`aggregator.ts#cleanupOldUsageLogs`). */
export const PROVIDER_CACHE_WINDOW_DAYS = [1, 7, 30] as const;
export type ProviderCacheWindowDays = (typeof PROVIDER_CACHE_WINDOW_DAYS)[number];

/** Models listed, most prompt tokens first. A ceiling: the gateway accepts any `modelId` string, so the count is not bounded by the registry. */
export const PROVIDER_CACHE_MODEL_LIMIT = 50;

export interface CacheCounts {
    cachedTokens: number;
    promptTokens: number;
    requests: number;
}

export interface ProviderCacheReadings {
    /** Every answered row in the window, caching pair or not. */
    all: CacheCounts;
    days: ProviderCacheWindowDays;
    /** Hours with traffic from caching models, oldest first; `hour` is its UTC start as an ISO string. */
    hours: (CacheCounts & { hour: string })[];
    models: (CacheCounts & { modelId: string; provider: string })[];
    /** Provider/model pairs with answered rows in the window; more than `models.length` when the list was cut. */
    pairs: number;
    /** The window's start, as an ISO string. */
    since: string;
}

/**
 * Rows a provider answered: not served by the response cache, not failed, with prompt tokens, and not a cancelled
 * call's estimate (`finish_reason = 'cancelled'`, written by the stream and model-proxy paths from
 * `lib/cancelled-usage.ts`). An estimate carries no cache count, so it would book every prompt token as a miss.
 */
const answered = (since: string): string =>
    `created_at >= ${since} AND cache_hit = 0 AND error_code IS NULL AND prompt_tokens > 0 AND finish_reason IS NOT 'cancelled'`;

/** Pairs are judged for caching over the longest window, so a complete drop inside a shorter window still shows. */
const ELIGIBILITY_DAYS = Math.max(...PROVIDER_CACHE_WINDOW_DAYS);

interface CountRow {
    cached_tokens: number | null;
    prompt_tokens: number | null;
    requests: number;
}

const countsOf = (row: CountRow): CacheCounts => {
    return { cachedTokens: row.cached_tokens ?? 0, promptTokens: row.prompt_tokens ?? 0, requests: row.requests };
};

/** A model row with the window's totals over every pair, which the window functions add before `LIMIT` applies. */
interface ModelRow extends CountRow {
    all_cached_tokens: number | null;
    all_prompt_tokens: number | null;
    all_requests: number;
    model_id: string;
    pairs: number;
    provider: string;
}

/** `YYYY-MM-DD HH` (the first 13 characters of a stored `created_at`) as the hour's ISO start. */
export const hourStart = (prefix: string): string => `${prefix.replace(" ", "T")}:00:00.000Z`;

export const readProviderCacheReadings = async (database: D1Database, days: ProviderCacheWindowDays, now: number): Promise<ProviderCacheReadings> => {
    const sinceMs = now - days * 86_400_000;
    const since = sqliteTime(sinceMs);
    const eligibilitySince = sqliteTime(now - ELIGIBILITY_DAYS * 86_400_000);

    const [hours, models] = await Promise.all([
        database
            .prepare(
                `SELECT substr(created_at, 1, 13) AS hour, COUNT(*) AS requests,
                        SUM(prompt_tokens) AS prompt_tokens, SUM(cached_tokens) AS cached_tokens
                 FROM usage_log
                 WHERE ${answered("?1")}
                   AND (provider, model_id) IN (SELECT provider, model_id FROM usage_log WHERE ${answered("?2")} GROUP BY provider, model_id HAVING SUM(cached_tokens) > 0)
                 GROUP BY hour
                 ORDER BY hour`,
            )
            .bind(since, eligibilitySince)
            .all<CountRow & { hour: string }>(),
        database
            .prepare(
                `SELECT provider, model_id, COUNT(*) AS requests,
                        SUM(prompt_tokens) AS prompt_tokens, SUM(cached_tokens) AS cached_tokens,
                        COUNT(*) OVER () AS pairs, SUM(COUNT(*)) OVER () AS all_requests,
                        SUM(SUM(prompt_tokens)) OVER () AS all_prompt_tokens, SUM(SUM(cached_tokens)) OVER () AS all_cached_tokens
                 FROM usage_log
                 WHERE ${answered("?1")}
                 GROUP BY provider, model_id
                 ORDER BY prompt_tokens DESC, model_id
                 LIMIT ?2`,
            )
            .bind(since, PROVIDER_CACHE_MODEL_LIMIT)
            .all<ModelRow>(),
    ]);

    const [first] = models.results;

    return {
        all:
            first === undefined
                ? { cachedTokens: 0, promptTokens: 0, requests: 0 }
                : countsOf({ cached_tokens: first.all_cached_tokens, prompt_tokens: first.all_prompt_tokens, requests: first.all_requests }),
        days,
        hours: hours.results.map((row) => {
            return { ...countsOf(row), hour: hourStart(row.hour) };
        }),
        models: models.results.map((row) => {
            return { ...countsOf(row), modelId: row.model_id, provider: row.provider };
        }),
        pairs: first?.pairs ?? 0,
        since: new Date(sinceMs).toISOString(),
    };
};
