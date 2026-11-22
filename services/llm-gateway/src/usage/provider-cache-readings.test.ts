/**
 * The provider cache readings run their SQL against the migrated schema: quarter hours and models are summed, the
 * response cache's own answers, failures, non-chat rows and rows outside the window are left out, and a model that never
 * caches is listed but kept out of the series.
 */
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { d1FromSqlite, migratedDatabase } from "../__tests__/helpers/sqlite-d1.js";
import { sqliteTime } from "../lib/sqlite-time.js";
import { answered, PROVIDER_CACHE_MODEL_LIMIT, quarterStart, readProviderCacheReadings } from "./provider-cache-readings.js";

const NOW = Date.UTC(2026, 10, 21, 12, 30);
const HOUR_MS = 3_600_000;

interface Row {
    cached: number;
    cacheHit?: number;
    completion?: number;
    errorCode?: string;
    finishReason?: string;
    hoursAgo: number;
    model: string;
    prompt: number;
    provider?: string;
    sessionType?: string;
}

/** A migrated database and an `insert` that adds one usage row to it. */
const usageLog = (): { db: DatabaseSync; insert: (row: Row) => void } => {
    const db = migratedDatabase();
    let rowCount = 0;

    const insert = (row: Row): void => {
        rowCount += 1;
        db.prepare(
            `INSERT INTO usage_log (id, request_id, user_id, model_id, provider, model_api_id, prompt_tokens, completion_tokens, cached_tokens, cache_hit, error_code, finish_reason, session_type, created_at)
             VALUES (?, ?, 'user-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            `row-${rowCount}`,
            `request-${rowCount}`,
            row.model,
            row.provider ?? "openrouter",
            row.model,
            row.prompt,
            row.completion ?? 50,
            row.cached,
            row.cacheHit ?? 0,
            row.errorCode ?? null,
            row.finishReason ?? null,
            row.sessionType ?? "text",
            sqliteTime(NOW - row.hoursAgo * HOUR_MS),
        );
    };

    return { db, insert };
};

describe("readProviderCacheReadings", () => {
    it("sums caching models by quarter hour and every model by model, inside the window", async () => {
        const { db, insert } = usageLog();

        insert({ cached: 900, hoursAgo: 1, model: "claude", prompt: 1000 });
        insert({ cached: 0, hoursAgo: 1, model: "claude", prompt: 1000 });
        insert({ cached: 800, hoursAgo: 3, model: "claude", prompt: 1000 });
        // Never caches: listed by model, left out of the hourly series.
        insert({ cached: 0, hoursAgo: 1, model: "workers-ai", prompt: 5000 });
        // Left out everywhere: answered by the response cache, failed, no prompt tokens, outside the window.
        insert({ cached: 0, cacheHit: 1, hoursAgo: 1, model: "claude", prompt: 1000 });
        insert({ cached: 0, errorCode: "upstream_error", hoursAgo: 1, model: "claude", prompt: 1000 });
        insert({ cached: 0, hoursAgo: 1, model: "claude", prompt: 0 });
        insert({ cached: 1000, hoursAgo: 25, model: "claude", prompt: 1000 });

        const readings = await readProviderCacheReadings(d1FromSqlite(db), 1, NOW);

        expect(readings.days).toBe(1);
        expect(readings.since).toBe(new Date(NOW - 24 * HOUR_MS).toISOString());
        expect(readings.quarters).toEqual([
            { cachedTokens: 800, promptTokens: 1000, requests: 1, start: "2026-11-21T09:30:00.000Z" },
            { cachedTokens: 900, promptTokens: 2000, requests: 2, start: "2026-11-21T11:30:00.000Z" },
        ]);
        expect(readings.models).toEqual([
            { cachedTokens: 0, modelId: "workers-ai", promptTokens: 5000, provider: "openrouter", requests: 1 },
            { cachedTokens: 1700, modelId: "claude", promptTokens: 3000, provider: "openrouter", requests: 3 },
        ]);
        expect(readings.all).toEqual({ cachedTokens: 1700, promptTokens: 8000, requests: 4 });
        expect(readings.pairs).toBe(2);
    });

    it("keeps the window's traffic when no pair cached in the last 30 days", async () => {
        const { db, insert } = usageLog();

        insert({ cached: 0, hoursAgo: 2, model: "claude", prompt: 1000 });
        insert({ cached: 0, hoursAgo: 1, model: "gpt", prompt: 3000 });

        const readings = await readProviderCacheReadings(d1FromSqlite(db), 1, NOW);

        expect(readings.quarters).toEqual([]);
        expect(readings.all).toEqual({ cachedTokens: 0, promptTokens: 4000, requests: 2 });
        expect(readings.pairs).toBe(2);
    });

    it("counts every pair when the model list is cut at its limit", async () => {
        const { db, insert } = usageLog();

        for (let index = 0; index <= PROVIDER_CACHE_MODEL_LIMIT; index += 1) {
            insert({ cached: 10, hoursAgo: 1, model: `model-${String(index)}`, prompt: 100 + index });
        }

        const readings = await readProviderCacheReadings(d1FromSqlite(db), 1, NOW);

        expect(readings.models).toHaveLength(PROVIDER_CACHE_MODEL_LIMIT);
        expect(readings.pairs).toBe(PROVIDER_CACHE_MODEL_LIMIT + 1);
        expect(readings.all.requests).toBe(PROVIDER_CACHE_MODEL_LIMIT + 1);
    });

    it("returns empty lists when nothing was answered in the window", async () => {
        const { db, insert } = usageLog();

        insert({ cached: 500, hoursAgo: 24 * 8, model: "claude", prompt: 1000 });

        const readings = await readProviderCacheReadings(d1FromSqlite(db), 7, NOW);

        expect(readings).toMatchObject({ all: { cachedTokens: 0, promptTokens: 0, requests: 0 }, models: [], pairs: 0, quarters: [] });
    });

    it("keeps a pair that stopped caching inside the window, so its drop shows", async () => {
        const { db, insert } = usageLog();

        // Cached 30 hours ago (outside the day, inside the 30-day lookback), then nothing cached in the last two hours.
        insert({ cached: 800, hoursAgo: 30, model: "claude", prompt: 1000 });
        insert({ cached: 0, hoursAgo: 2, model: "claude", prompt: 1000 });
        insert({ cached: 0, hoursAgo: 1, model: "claude", prompt: 1000 });

        const readings = await readProviderCacheReadings(d1FromSqlite(db), 1, NOW);

        expect(readings.quarters).toEqual([
            { cachedTokens: 0, promptTokens: 1000, requests: 1, start: "2026-11-21T10:30:00.000Z" },
            { cachedTokens: 0, promptTokens: 1000, requests: 1, start: "2026-11-21T11:30:00.000Z" },
        ]);
    });

    it("does not let another provider's rows for the same model id dilute the share", async () => {
        const { db, insert } = usageLog();

        insert({ cached: 900, hoursAgo: 1, model: "gemini", prompt: 1000, provider: "google" });
        // The same model id, served by a provider that never caches.
        insert({ cached: 0, hoursAgo: 1, model: "gemini", prompt: 5000, provider: "openrouter" });

        const readings = await readProviderCacheReadings(d1FromSqlite(db), 1, NOW);

        expect(readings.quarters).toEqual([{ cachedTokens: 900, promptTokens: 1000, requests: 1, start: "2026-11-21T11:30:00.000Z" }]);
        expect(readings.models).toEqual([
            { cachedTokens: 0, modelId: "gemini", promptTokens: 5000, provider: "openrouter", requests: 1 },
            { cachedTokens: 900, modelId: "gemini", promptTokens: 1000, provider: "google", requests: 1 },
        ]);
    });

    it("leaves a cancelled stream's estimate out, since its cache hits are unknown", async () => {
        const { db, insert } = usageLog();

        insert({ cached: 800, hoursAgo: 1, model: "claude", prompt: 1000 });
        // Stopped before the provider's usage arrived: every prompt token is an estimate booked as a miss.
        insert({ cached: 0, finishReason: "cancelled", hoursAgo: 1, model: "claude", prompt: 4000 });

        const readings = await readProviderCacheReadings(d1FromSqlite(db), 1, NOW);

        expect(readings.quarters).toEqual([{ cachedTokens: 800, promptTokens: 1000, requests: 1, start: "2026-11-21T11:30:00.000Z" }]);
        expect(readings.models).toEqual([{ cachedTokens: 800, modelId: "claude", promptTokens: 1000, provider: "openrouter", requests: 1 }]);
    });

    it("cuts each row to its quarter hour", async () => {
        const { db, insert } = usageLog();

        // NOW is 12:30, so these land at 12:16, 12:29 and 12:01.
        insert({ cached: 100, hoursAgo: 14 / 60, model: "claude", prompt: 1000 });
        insert({ cached: 100, hoursAgo: 1 / 60, model: "claude", prompt: 1000 });
        insert({ cached: 100, hoursAgo: 29 / 60, model: "claude", prompt: 1000 });

        const readings = await readProviderCacheReadings(d1FromSqlite(db), 1, NOW);

        expect(readings.quarters).toEqual([
            { cachedTokens: 100, promptTokens: 1000, requests: 1, start: "2026-11-21T12:00:00.000Z" },
            { cachedTokens: 200, promptTokens: 2000, requests: 2, start: "2026-11-21T12:15:00.000Z" },
        ]);
        expect(quarterStart("2026-11-21 09:45")).toBe("2026-11-21T09:45:00.000Z");
    });

    it("leaves out rows that are not chat prompts: no completion tokens, or a realtime session", async () => {
        const { db, insert } = usageLog();

        insert({ cached: 800, hoursAgo: 1, model: "claude", prompt: 1000 });
        // Music stores one generation, video its seconds, speech its characters, embeddings their tokens: none has output tokens.
        insert({ cached: 0, completion: 0, hoursAgo: 1, model: "music-model", prompt: 1 });
        insert({ cached: 0, completion: 0, hoursAgo: 1, model: "embedding-model", prompt: 90_000 });
        insert({ cached: 0, hoursAgo: 1, model: "gpt-realtime", prompt: 4000, sessionType: "realtime" });

        const readings = await readProviderCacheReadings(d1FromSqlite(db), 1, NOW);

        expect(readings.all).toEqual({ cachedTokens: 800, promptTokens: 1000, requests: 1 });
        expect(readings.models.map((model) => model.modelId)).toEqual(["claude"]);
    });

    it("reads both queries from migration 0017's covering index alone", () => {
        const { db } = usageLog();
        const plan = (sql: string): string =>
            (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("2026-11-01 00:00:00") as { detail: string }[]).map((row) => row.detail).join("\n");

        // A term in the index's WHERE that `answered()` lacks, or a filtered column the index leaves out, loses the covering index.
        expect(
            plan(`SELECT provider, model_id, SUM(prompt_tokens), SUM(cached_tokens) FROM usage_log WHERE ${answered("?1")} GROUP BY provider, model_id`),
        ).toContain("USING COVERING INDEX idx_usage_log_provider_cache");
    });
});
