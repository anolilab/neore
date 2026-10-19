/// <reference types="node" />

/**
 * `readDailyUsage` against a real SQLite database, with `usage_log` built by applying
 * the gateway's migrations in order. The mock-D1 tests in daily-limit.test.ts cannot
 * catch a wrong predicate, an off-by-one bound or a column that does not exist.
 *
 * Rows are placed with SQLite's `datetime(anchor, modifier)` from a fixed UTC midnight,
 * and `now` is passed in explicitly, so nothing here reads the clock.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { readDailyUsage } from "../middleware/daily-limit.js";

const MIDNIGHT = "2026-10-19 00:00:00";

const MIGRATIONS = join(import.meta.dirname, "../../migrations");

const migratedDatabase = (): DatabaseSync => {
    const db = new DatabaseSync(":memory:");
    // Zero-padded names, so a plain string order is the migration order.
    const files = readdirSync(MIGRATIONS)
        .filter((name) => name.endsWith(".sql"))
        .toSorted((a, b) => a.localeCompare(b));

    for (const file of files) {
        db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    }

    return db;
};

/** The part of D1 that `readDailyUsage` uses, answered by the local database. */
const d1 = (db: DatabaseSync): D1Database =>
    ({
        prepare: (sql: string) => {
            return {
                bind: (...values: string[]) => {
                    return {
                        first: async () => db.prepare(sql).get(...values) ?? null,
                    };
                },
            };
        },
    }) as unknown as D1Database;

interface Row {
    /** A SQLite time modifier from MIDNIGHT: `"-30 seconds"` is 23:59:30 the day before. */
    at: string;
    source?: "internal" | "saas_api";
    /** Prompt plus completion tokens; the row stores `tokens - 1` and `1`, so the sum is exact. */
    tokens: number;
    userId?: string;
}

const seed = (rows: Row[]): D1Database => {
    const db = migratedDatabase();
    const insert = db.prepare(
        `INSERT INTO usage_log (id, request_id, user_id, model_id, provider, model_api_id, prompt_tokens, completion_tokens, source, created_at)
         VALUES (?, ?, ?, 'model', 'provider', 'model-api', ?, 1, ?, datetime(?, ?))`,
    );

    rows.forEach((row, index) => {
        insert.run(`row-${index}`, `req-${index}`, row.userId ?? "user-1", row.tokens - 1, row.source ?? "saas_api", MIDNIGHT, row.at);
    });

    return d1(db);
};

describe("readDailyUsage against the usage_log schema", () => {
    it("counts the day from 00:00 UTC, and the minute across midnight, for this user's API rows only", async () => {
        const db = seed([
            { at: "-90 seconds", tokens: 1000 },
            { at: "-30 seconds", tokens: 100 },
            { at: "+0 seconds", tokens: 1 },
            { at: "+5 seconds", tokens: 10 },
            { at: "+5 seconds", source: "internal", tokens: 5000 },
            { at: "+5 seconds", tokens: 7000, userId: "user-2" },
        ]);

        // 00:00:20 UTC: the minute began at 23:59:20 the day before.
        expect(await readDailyUsage(db, "user-1", Date.UTC(2026, 9, 19, 0, 0, 20))).toEqual({
            requests: 2,
            tokens: 11,
            tokensLastMinute: 111,
        });
    });

    it("includes a row exactly one minute old, and drops one a second older", async () => {
        // Noon UTC: the minute starts at 11:59:00.
        const db = seed([
            { at: "+43139 seconds", tokens: 100 },
            { at: "+43140 seconds", tokens: 1000 },
            { at: "+43170 seconds", tokens: 10 },
            { at: "+5 seconds", tokens: 1 },
        ]);

        expect(await readDailyUsage(db, "user-1", Date.UTC(2026, 9, 19, 12, 0, 0))).toEqual({
            requests: 4,
            tokens: 1111,
            tokensLastMinute: 1010,
        });
    });

    it("is zero for a user with no rows", async () => {
        expect(await readDailyUsage(seed([]), "user-1", Date.UTC(2026, 9, 19, 12, 0, 0))).toEqual({
            requests: 0,
            tokens: 0,
            tokensLastMinute: 0,
        });
    });
});
