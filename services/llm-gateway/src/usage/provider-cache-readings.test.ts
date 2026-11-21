/**
 * The provider cache readings run their SQL against the migrated schema: hours and models are summed, the response
 * cache's own answers, failures and rows outside the window are left out, and a model that never caches is listed but
 * kept out of the hourly series.
 */
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { d1FromSqlite, migratedDatabase } from "../__tests__/helpers/sqlite-d1.js";
import { sqliteTime } from "../lib/sqlite-time.js";
import { hourStart, readProviderCacheReadings } from "./provider-cache-readings.js";

const NOW = Date.UTC(2026, 10, 21, 12, 30);
const HOUR_MS = 3_600_000;

interface Row {
    cached: number;
    cacheHit?: number;
    errorCode?: string;
    hoursAgo: number;
    model: string;
    prompt: number;
}

/** A migrated database and an `insert` that adds one usage row to it. */
const usageLog = (): { db: DatabaseSync; insert: (row: Row) => void } => {
    const db = migratedDatabase();
    let rowCount = 0;

    const insert = (row: Row): void => {
        rowCount += 1;
        db.prepare(
            `INSERT INTO usage_log (id, request_id, user_id, model_id, provider, model_api_id, prompt_tokens, cached_tokens, cache_hit, error_code, created_at)
             VALUES (?, ?, 'user-1', ?, 'openrouter', ?, ?, ?, ?, ?, ?)`,
        ).run(
            `row-${rowCount}`,
            `request-${rowCount}`,
            row.model,
            row.model,
            row.prompt,
            row.cached,
            row.cacheHit ?? 0,
            row.errorCode ?? null,
            sqliteTime(NOW - row.hoursAgo * HOUR_MS),
        );
    };

    return { db, insert };
};

describe("readProviderCacheReadings", () => {
    it("sums caching models by hour and every model by model, inside the window", async () => {
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
        expect(readings.hours).toEqual([
            { cachedTokens: 800, hour: "2026-11-21T09:00:00.000Z", promptTokens: 1000, requests: 1 },
            { cachedTokens: 900, hour: "2026-11-21T11:00:00.000Z", promptTokens: 2000, requests: 2 },
        ]);
        expect(readings.models).toEqual([
            { cachedTokens: 0, modelId: "workers-ai", promptTokens: 5000, provider: "openrouter", requests: 1 },
            { cachedTokens: 1700, modelId: "claude", promptTokens: 3000, provider: "openrouter", requests: 3 },
        ]);
    });

    it("returns empty lists when nothing was answered in the window", async () => {
        const { db, insert } = usageLog();

        insert({ cached: 500, hoursAgo: 24 * 8, model: "claude", prompt: 1000 });

        const readings = await readProviderCacheReadings(d1FromSqlite(db), 7, NOW);

        expect(readings).toMatchObject({ hours: [], models: [] });
    });

    it("turns a stored hour prefix into its ISO start", () => {
        expect(hourStart("2026-11-21 09")).toBe("2026-11-21T09:00:00.000Z");
    });
});
