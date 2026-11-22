/**
 * Provider prompt-cache readings from `usage_log`: how many prompt tokens a provider served from its own cache
 * (`cached_tokens`, the provider's cache reads), by quarter hour and by model. This is the provider's prefix cache, not the
 * gateway's exact-match response cache (`cache_hit`, `lib/prompt-cache.ts`); rows the response cache answered are
 * left out, since no provider saw them.
 *
 * Quarter hours, not hours, so the admin card can sum them into the hours and days of any time zone, including the
 * ones offset by 30 or 45 minutes. The series counts only the provider/model pairs that reported cached tokens at least once in the last 30 days,
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
    models: (CacheCounts & { modelId: string; provider: string })[];
    /** Provider/model pairs with answered rows in the window; more than `models.length` when the list was cut. */
    pairs: number;
    /** Quarter hours with traffic from caching models, oldest first; `start` is its UTC start as an ISO string. */
    quarters: (CacheCounts & { start: string })[];
    /** The window's start, as an ISO string. */
    since: string;
}

/**
 * Chat rows a provider answered: not served by the response cache, not failed, with prompt tokens, and not a cancelled
 * call's estimate (`finish_reason = 'cancelled'`, written by the stream and model-proxy paths from
 * `lib/cancelled-usage.ts`); an estimate carries no cache count, so it would book every prompt token as a miss.
 *
 * Chat only: speech, transcription, music, video and embeddings rows store characters, seconds, a generation count or
 * embedding tokens in `prompt_tokens`. A row is chat when `operation = 'chat'` (migration 0017). A row with no operation
 * (written before that column, or by a writer that passes none) counts when it has completion or cached tokens, which
 * none of the non-chat writers record; realtime rows have `session_type = 'realtime'`. So the 90 days of older rows
 * still count, and an empty chat reply that read the cache is kept.
 *
 * Migration 0017's partial index has this clause as its WHERE and every column it reads: a term the index adds that this
 * lacks, or a column it reads that the index leaves out, sends both queries back to the table. Change both together.
 */
export const answered = (since: string): string =>
    `created_at >= ${since} AND cache_hit = 0 AND error_code IS NULL AND prompt_tokens > 0 AND session_type = 'text' AND finish_reason IS NOT 'cancelled' AND (operation = 'chat' OR (operation IS NULL AND (completion_tokens > 0 OR cached_tokens > 0)))`;

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

/** A stored `created_at` (`YYYY-MM-DD HH:MM:SS`) cut to its quarter hour, `YYYY-MM-DD HH:MM`. */
const QUARTER = "substr(created_at, 1, 14) || printf('%02d', CAST(substr(created_at, 15, 2) AS INTEGER) / 15 * 15)";

/** `YYYY-MM-DD HH:MM` as the quarter hour's ISO start. */
export const quarterStart = (prefix: string): string => `${prefix.replace(" ", "T")}:00.000Z`;

export const readProviderCacheReadings = async (database: D1Database, days: ProviderCacheWindowDays, now: number): Promise<ProviderCacheReadings> => {
    const sinceMs = now - days * 86_400_000;
    const since = sqliteTime(sinceMs);
    const eligibilitySince = sqliteTime(now - ELIGIBILITY_DAYS * 86_400_000);

    const [quarters, models] = await Promise.all([
        database
            .prepare(
                `SELECT ${QUARTER} AS quarter, COUNT(*) AS requests,
                        SUM(prompt_tokens) AS prompt_tokens, SUM(cached_tokens) AS cached_tokens
                 FROM usage_log
                 WHERE ${answered("?1")}
                   AND (provider, model_id) IN (SELECT provider, model_id FROM usage_log WHERE ${answered("?2")} GROUP BY provider, model_id HAVING SUM(cached_tokens) > 0)
                 GROUP BY quarter
                 ORDER BY quarter`,
            )
            .bind(since, eligibilitySince)
            .all<CountRow & { quarter: string }>(),
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
        models: models.results.map((row) => {
            return { ...countsOf(row), modelId: row.model_id, provider: row.provider };
        }),
        pairs: first?.pairs ?? 0,
        quarters: quarters.results.map((row) => {
            return { ...countsOf(row), start: quarterStart(row.quarter) };
        }),
        since: new Date(sinceMs).toISOString(),
    };
};
