/// <reference types="node" />

/**
 * `UsageAggregator` against a real SQLite database with the gateway's migrated schema.
 * The mock D1 never evaluates a predicate, so it cannot tell a wrong `WHERE`, `GROUP BY`
 * or join from a right one — and the SQL is this module's whole contract.
 *
 * `usage_log.created_at` is stored the way production writes it: SQLite's
 * `datetime('now')`, i.e. `YYYY-MM-DD HH:MM:SS` in UTC. The clock is fixed to NOW.
 */
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { d1FromSqlite, migratedDatabase } from "../__tests__/helpers/sqlite-d1.js";
import type { AppEnv } from "../env.js";
import { UsageAggregator } from "./aggregator.js";

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

/** `YYYY-MM-DD` of the UTC day `daysAgo` days before NOW. */
const dayOf = (daysAgo: number): string => new Date(NOW - daysAgo * 86_400_000).toISOString().slice(0, 10);

/** A `created_at` value in production's format. */
const at = (daysAgo: number, time = "12:00:00"): string => `${dayOf(daysAgo)} ${time}`;

interface LogRow {
    completion?: number;
    cost?: number;
    createdAt: string;
    error?: string;
    latency?: number;
    model?: string;
    orgId?: string;
    prompt?: number;
    user?: string;
}

const t = { nextId: 0 } as { aggregator: UsageAggregator; db: DatabaseSync; nextId: number };

const log = (...rows: LogRow[]): void => {
    const insert = t.db.prepare(
        `INSERT INTO usage_log (id, request_id, user_id, org_id, model_id, provider, model_api_id, prompt_tokens, completion_tokens, cost_microdollars, latency_ms, error_code, created_at)
         VALUES (?, ?, ?, ?, ?, 'provider', 'model-api', ?, ?, ?, ?, ?, ?)`,
    );

    for (const row of rows) {
        t.nextId += 1;
        insert.run(
            `id-${t.nextId}`,
            `req-${t.nextId}`,
            row.user ?? "user-1",
            row.orgId ?? null,
            row.model ?? "model-a",
            row.prompt ?? 0,
            row.completion ?? 0,
            row.cost ?? 0,
            row.latency ?? 0,
            row.error ?? null,
            row.createdAt,
        );
    }
};

const daily = () =>
    t.db
        .prepare(
            `SELECT user_id, org_id, model_id, date, request_count, prompt_tokens, completion_tokens, total_cost_microdollars, avg_latency_ms, error_count
             FROM usage_daily ORDER BY user_id, org_id, model_id, date`,
        )
        .all();

const remainingLogs = (): number => (t.db.prepare("SELECT COUNT(*) AS n FROM usage_log").get() as { n: number }).n;

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    t.db = migratedDatabase();
    t.aggregator = new UsageAggregator({ USAGE_DB: d1FromSqlite(t.db) } as AppEnv);
    t.nextId = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

describe("UsageAggregator.getUserUsage", () => {
    it("sums requests, tokens and cost per model, and in total", async () => {
        log(
            { completion: 50, cost: 1000, createdAt: at(1), model: "model-a", prompt: 100 },
            { completion: 25, cost: 500, createdAt: at(2), model: "model-a", prompt: 10 },
            { completion: 7, cost: 90, createdAt: at(3), model: "model-b", prompt: 3 },
        );

        expect(await t.aggregator.getUserUsage("user-1")).toEqual({
            byModel: {
                "model-a": { cost: 1500, requests: 2, tokens: 185 },
                "model-b": { cost: 90, requests: 1, tokens: 10 },
            },
            period: "30d",
            totalCompletionTokens: 82,
            totalCostMicrodollars: 1590,
            totalPromptTokens: 113,
            totalRequests: 3,
        });
    });

    it("counts a failed call as a request, with the tokens and cost it logged", async () => {
        log({ completion: 0, cost: 0, createdAt: at(1), error: "provider_error", prompt: 40 });

        expect(await t.aggregator.getUserUsage("user-1")).toMatchObject({
            byModel: { "model-a": { cost: 0, requests: 1, tokens: 40 } },
            totalRequests: 1,
        });
    });

    it("leaves other users' usage out", async () => {
        log({ cost: 100, createdAt: at(1), prompt: 1 }, { cost: 9999, createdAt: at(1), prompt: 999, user: "user-2" });

        expect(await t.aggregator.getUserUsage("user-1")).toMatchObject({ totalCostMicrodollars: 100, totalPromptTokens: 1, totalRequests: 1 });
    });

    it.each([
        { days: 7, expected: 1, period: "7d" },
        { days: 30, expected: 2, period: "30d" },
        { days: 90, expected: 3, period: "90d" },
    ])("reads only the last $days days and labels the period $period", async ({ days, expected, period }) => {
        log({ createdAt: at(3) }, { createdAt: at(20) }, { createdAt: at(60) }, { createdAt: at(120) });

        const usage = await t.aggregator.getUserUsage("user-1", days);

        // Rows at 3, 20 and 60 days against 7/30/90: one, two, three inside (120 is always out).
        expect(usage.totalRequests).toBe(expected);
        expect(usage.period).toBe(period);
    });

    it("reports an empty summary for a user with no usage", async () => {
        log({ createdAt: at(120) });

        expect(await t.aggregator.getUserUsage("user-1")).toEqual({
            byModel: {},
            period: "30d",
            totalCompletionTokens: 0,
            totalCostMicrodollars: 0,
            totalPromptTokens: 0,
            totalRequests: 0,
        });
    });

    // `created_at` is `YYYY-MM-DD HH:MM:SS`, so the window start must be in that format too: as an
    // ISO string (`T`) it would sort after every row on the cutoff's own date.
    it("includes a row logged later on the cutoff day, inside the window", async () => {
        // NOW is 12:00 on the 19th; a 30-day window starts 12:00 on the 19th of the previous month.
        log({ createdAt: at(30, "18:00:00") });

        const summary = await t.aggregator.getUserUsage("user-1", 30);

        expect(summary.totalRequests).toBe(1);
    });
});

describe("UsageAggregator.materializeDailyAggregates", () => {
    it("rolls one day's calls up per user, org and model", async () => {
        const day = dayOf(1);

        log(
            { completion: 20, cost: 300, createdAt: `${day} 01:00:00`, latency: 100, prompt: 10 },
            { completion: 40, cost: 500, createdAt: `${day} 23:59:59`, error: "timeout", latency: 300, prompt: 30 },
            { createdAt: `${day} 10:00:00`, latency: 50, model: "model-b" },
        );

        await t.aggregator.materializeDailyAggregates(day);

        expect(daily()).toEqual([
            expect.objectContaining({
                avg_latency_ms: 200,
                completion_tokens: 60,
                date: day,
                error_count: 1,
                model_id: "model-a",
                org_id: "",
                prompt_tokens: 40,
                request_count: 2,
                total_cost_microdollars: 800,
                user_id: "user-1",
            }),
            expect.objectContaining({ date: day, error_count: 0, model_id: "model-b", request_count: 1 }),
        ]);
    });

    it("rolls up only the requested day", async () => {
        log({ createdAt: `${dayOf(2)} 23:59:59` }, { createdAt: `${dayOf(1)} 12:00:00` }, { createdAt: `${dayOf(0)} 00:00:00` });

        await t.aggregator.materializeDailyAggregates(dayOf(1));

        expect(daily()).toEqual([expect.objectContaining({ date: dayOf(1), request_count: 1 })]);
    });

    it("defaults to today, in UTC", async () => {
        log({ createdAt: `${dayOf(0)} 08:00:00` }, { createdAt: `${dayOf(1)} 08:00:00` });

        await t.aggregator.materializeDailyAggregates();

        expect(daily()).toEqual([expect.objectContaining({ date: dayOf(0), request_count: 1 })]);
    });

    it("keeps each organisation, and a user with no organisation, in its own row", async () => {
        const createdAt = `${dayOf(1)} 09:00:00`;

        log({ createdAt, orgId: "org-1" }, { createdAt, orgId: "org-2" }, { createdAt }, { createdAt, user: "user-2" });

        await t.aggregator.materializeDailyAggregates(dayOf(1));

        expect(daily().map((row) => [row["user_id"], row["org_id"], row["request_count"]])).toEqual([
            ["user-1", "", 1],
            ["user-1", "org-1", 1],
            ["user-1", "org-2", 1],
            ["user-2", "", 1],
        ]);
    });

    it("writes nothing for a day without calls", async () => {
        log({ createdAt: at(5) });

        await t.aggregator.materializeDailyAggregates(dayOf(1));

        expect(daily()).toEqual([]);
    });

    it("can be re-run for a day: the row is replaced with the new totals, not doubled", async () => {
        const day = dayOf(1);

        log({ cost: 100, createdAt: `${day} 09:00:00` });
        await t.aggregator.materializeDailyAggregates(day);
        await t.aggregator.materializeDailyAggregates(day);

        expect(daily()).toEqual([expect.objectContaining({ request_count: 1, total_cost_microdollars: 100 })]);

        log({ cost: 50, createdAt: `${day} 10:00:00` });
        await t.aggregator.materializeDailyAggregates(day);

        expect(daily()).toEqual([expect.objectContaining({ request_count: 2, total_cost_microdollars: 150 })]);
    });
});

describe("UsageAggregator.cleanupOldUsageLogs", () => {
    /** Log a call on `daysAgo`, and materialize that day unless told not to. */
    const aged = async (daysAgo: number, options: { aggregate?: boolean; count?: number; user?: string } = {}) => {
        const rows = Array.from({ length: options.count ?? 1 }, (_, index) => {
            return { createdAt: at(daysAgo, `10:00:${String(index).padStart(2, "0")}`), user: options.user ?? "user-1" };
        });

        log(...rows);

        if (options.aggregate !== false) {
            await t.aggregator.materializeDailyAggregates(dayOf(daysAgo));
        }
    };

    it("deletes aggregated rows older than the retention window and keeps the rest", async () => {
        await aged(120, { count: 3 });
        await aged(100);
        await aged(10, { count: 2 });

        expect(await t.aggregator.cleanupOldUsageLogs()).toBe(4);
        expect(remainingLogs()).toBe(2);
    });

    it("keeps the aggregates it deletes the raw rows behind", async () => {
        await aged(120, { count: 3 });

        await t.aggregator.cleanupOldUsageLogs();

        expect(daily()).toEqual([expect.objectContaining({ date: dayOf(120), request_count: 3 })]);
    });

    it("never deletes a row that has not been aggregated", async () => {
        await aged(120, { aggregate: false, count: 2 });

        expect(await t.aggregator.cleanupOldUsageLogs()).toBe(0);
        expect(remainingLogs()).toBe(2);
    });

    it("only deletes a row once its own user, model and day are aggregated", async () => {
        const day = dayOf(120);

        log({ createdAt: `${day} 10:00:00` }, { createdAt: `${day} 10:00:01`, model: "model-b" }, { createdAt: `${day} 10:00:02`, user: "user-2" });
        t.db.prepare("INSERT INTO usage_daily (user_id, org_id, model_id, date) VALUES ('user-1', '', 'model-a', ?)").run(day);

        expect(await t.aggregator.cleanupOldUsageLogs()).toBe(1);
        expect(remainingLogs()).toBe(2);
    });

    it("covers a whole day: a row at 23:59:59 goes, the first row of the next day stays until that day is aggregated", async () => {
        const day = dayOf(120);

        log({ createdAt: `${day} 23:59:59` }, { createdAt: `${dayOf(119)} 00:00:00` });
        await t.aggregator.materializeDailyAggregates(day);

        expect(await t.aggregator.cleanupOldUsageLogs()).toBe(1);
        expect(t.db.prepare("SELECT created_at FROM usage_log").all()).toEqual([{ created_at: `${dayOf(119)} 00:00:00` }]);
    });

    it("honours the retention argument and keeps the cutoff day itself", async () => {
        await aged(8);
        await aged(7);
        await aged(6);

        expect(await t.aggregator.cleanupOldUsageLogs(7)).toBe(1);
        expect(t.db.prepare("SELECT created_at FROM usage_log ORDER BY created_at").all()).toEqual([
            { created_at: at(7, "10:00:00") },
            { created_at: at(6, "10:00:00") },
        ]);
    });

    it.each([
        { batchSize: 2, rows: 5 },
        { batchSize: 2, rows: 4 },
        { batchSize: 5, rows: 5 },
        { batchSize: 1, rows: 3 },
        { batchSize: 10, rows: 3 },
    ])("deletes $rows rows in batches of $batchSize and reports the total", async ({ batchSize, rows }) => {
        await aged(120, { count: rows });

        expect(await t.aggregator.cleanupOldUsageLogs(90, batchSize)).toBe(rows);
        expect(remainingLogs()).toBe(0);
    });

    it("returns 0 and stops on an empty table", async () => {
        expect(await t.aggregator.cleanupOldUsageLogs()).toBe(0);
    });

    it("is idempotent", async () => {
        await aged(120, { count: 2 });

        expect(await t.aggregator.cleanupOldUsageLogs()).toBe(2);
        expect(await t.aggregator.cleanupOldUsageLogs()).toBe(0);
    });
});
