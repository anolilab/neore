/**
 * Provider prompt-cache readings from `usage_log`: how many prompt tokens a provider served from its own cache
 * (`cached_tokens`, the provider's cache reads), by hour and by model. This is the provider's prefix cache, not the
 * gateway's exact-match response cache (`cache_hit`, `lib/prompt-cache.ts`); rows the response cache answered are
 * left out, since no provider saw them.
 *
 * The hourly series counts only the models that reported cached tokens at least once in the window, so a model that
 * never caches does not dilute the share; the per-model list shows every model. A drop in the hourly share after a
 * deploy is the reading the prompt-versioning decision waits on (gap-backlog, "Prompt text fixed per thread").
 */
import { sqliteTime } from "../lib/sqlite-time.js";

/** Windows an admin can ask for; raw rows are kept 90 days (`aggregator.ts#cleanupOldUsageLogs`). */
export const PROVIDER_CACHE_WINDOW_DAYS = [1, 7, 30] as const;
export type ProviderCacheWindowDays = (typeof PROVIDER_CACHE_WINDOW_DAYS)[number];

/** Models listed, most prompt tokens first. */
export const PROVIDER_CACHE_MODEL_LIMIT = 50;

export interface CacheCounts {
    cachedTokens: number;
    promptTokens: number;
    requests: number;
}

export interface ProviderCacheReadings {
    days: ProviderCacheWindowDays;
    /** Hours with traffic from caching models, oldest first; `hour` is its UTC start as an ISO string. */
    hours: (CacheCounts & { hour: string })[];
    models: (CacheCounts & { modelId: string; provider: string })[];
    /** The window's start, as an ISO string. */
    since: string;
}

/** Rows a provider answered: not served by the response cache, not failed, with prompt tokens. */
const ANSWERED = "created_at >= ?1 AND cache_hit = 0 AND error_code IS NULL AND prompt_tokens > 0";

interface CountRow {
    cached_tokens: number | null;
    prompt_tokens: number | null;
    requests: number;
}

const countsOf = (row: CountRow): CacheCounts => {
    return { cachedTokens: row.cached_tokens ?? 0, promptTokens: row.prompt_tokens ?? 0, requests: row.requests };
};

/** `YYYY-MM-DD HH` (the first 13 characters of a stored `created_at`) as the hour's ISO start. */
export const hourStart = (prefix: string): string => `${prefix.replace(" ", "T")}:00:00.000Z`;

export const readProviderCacheReadings = async (database: D1Database, days: ProviderCacheWindowDays, now: number): Promise<ProviderCacheReadings> => {
    const sinceMs = now - days * 86_400_000;
    const since = sqliteTime(sinceMs);

    const [hours, models] = await Promise.all([
        database
            .prepare(
                `SELECT substr(created_at, 1, 13) AS hour, COUNT(*) AS requests,
                        SUM(prompt_tokens) AS prompt_tokens, SUM(cached_tokens) AS cached_tokens
                 FROM usage_log
                 WHERE ${ANSWERED}
                   AND model_id IN (SELECT model_id FROM usage_log WHERE ${ANSWERED} GROUP BY model_id HAVING SUM(cached_tokens) > 0)
                 GROUP BY hour
                 ORDER BY hour`,
            )
            .bind(since)
            .all<CountRow & { hour: string }>(),
        database
            .prepare(
                `SELECT provider, model_id, COUNT(*) AS requests,
                        SUM(prompt_tokens) AS prompt_tokens, SUM(cached_tokens) AS cached_tokens
                 FROM usage_log
                 WHERE ${ANSWERED}
                 GROUP BY provider, model_id
                 ORDER BY prompt_tokens DESC, model_id
                 LIMIT ?2`,
            )
            .bind(since, PROVIDER_CACHE_MODEL_LIMIT)
            .all<CountRow & { model_id: string; provider: string }>(),
    ]);

    return {
        days,
        hours: hours.results.map((row) => {
            return { ...countsOf(row), hour: hourStart(row.hour) };
        }),
        models: models.results.map((row) => {
            return { ...countsOf(row), modelId: row.model_id, provider: row.provider };
        }),
        since: new Date(sinceMs).toISOString(),
    };
};
