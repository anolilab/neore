/// <reference types="node" />

/**
 * `evaluateRules` beyond the cooldown-claim races that tracker.notifications.test.ts covers:
 * which rules are considered, how each metric and period is measured, what a firing rule
 * turns into (a notification, a block, or both), and what the cooldown does to the next
 * evaluation. Run against a real SQLite database with the gateway's migrated schema, since
 * the metric and period queries are this module's contract and the mock D1 evaluates none of
 * them.
 *
 * `usage_log.created_at` is stored as production writes it, SQLite's `datetime('now')`:
 * `YYYY-MM-DD HH:MM:SS`, UTC. Period tests fix `Date` to NOW; cooldown tests use the real
 * clock, because the cooldown claim compares against SQLite's own `datetime('now')`.
 */
import type { DatabaseSync } from "node:sqlite";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { d1FromSqlite, migratedDatabase } from "../__tests__/helpers/sqlite-d1.js";
import type { AppEnv } from "../env.js";
import { evaluateRules } from "./notifications.js";
import type { UsageLogEntry } from "./tracker.js";

// Workers run in UTC. The month period starts at local midnight and a stored cooldown
// timestamp is parsed as local time, so the suite pins the same zone.
const originalTimeZone = process.env["TZ"];

process.env["TZ"] = "UTC";

afterAll(() => {
    if (originalTimeZone === undefined) {
        delete process.env["TZ"];
    } else {
        process.env["TZ"] = originalTimeZone;
    }
});

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

const usage = (modelId = "model-a"): UsageLogEntry => ({ modelId }) as UsageLogEntry;

const notificationsFor = (modelId?: string) => evaluateRules(t.env, "user-1", undefined, usage(modelId)).then((result) => result.notifications);

interface RuleRow {
    action?: "block" | "notify" | "notify_and_block";
    active?: boolean;
    id?: string;
    metric?: string;
    modelFilter?: string;
    name?: string;
    period?: string;
    threshold: number;
    /** A SQLite modifier from now, e.g. `-30 minutes`. Unset: never fired. */
    triggered?: string;
    user?: string;
}

interface LogRow {
    completion?: number;
    cost?: number;
    createdAt: string;
    model?: string;
    prompt?: number;
    user?: string;
}

const t = { rowId: 0 } as { db: DatabaseSync; env: AppEnv; rowId: number };

const addRule = (rule: RuleRow): string => {
    t.rowId += 1;

    const id = rule.id ?? `rule-${t.rowId}`;

    t.db.prepare(
        `INSERT INTO notification_rules (id, user_id, name, metric, threshold, period, model_filter, action, is_active, last_triggered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END)`,
    ).run(
        id,
        rule.user ?? "user-1",
        rule.name ?? `Rule ${t.rowId}`,
        rule.metric ?? "request_count",
        rule.threshold,
        rule.period ?? "day",
        rule.modelFilter ?? null,
        rule.action ?? "notify",
        rule.active === false ? 0 : 1,
        rule.triggered ?? null,
        rule.triggered ?? "+0 seconds",
    );

    return id;
};

const addLogs = (...rows: LogRow[]): void => {
    const insert = t.db.prepare(
        `INSERT INTO usage_log (id, request_id, user_id, model_id, provider, model_api_id, prompt_tokens, completion_tokens, cost_microdollars, created_at)
         VALUES (?, ?, ?, ?, 'provider', 'model-api', ?, ?, ?, ?)`,
    );

    for (const row of rows) {
        t.rowId += 1;
        insert.run(`log-${t.rowId}`, `req-${t.rowId}`, row.user ?? "user-1", row.model ?? "model-a", row.prompt ?? 0, row.completion ?? 0, row.cost ?? 0, row.createdAt);
    }
};

/** SQLite's own `datetime('now', modifier)`, in the format `created_at` uses. */
const sqliteTime = (modifier: string): string => (t.db.prepare("SELECT datetime('now', ?) AS t").get(modifier) as { t: string }).t;

const lastTriggered = (id: string): string | null =>
    (t.db.prepare("SELECT last_triggered_at AS t FROM notification_rules WHERE id = ?").get(id) as { t: string | null }).t;

beforeEach(() => {
    t.db = migratedDatabase();
    t.env = { USAGE_DB: d1FromSqlite(t.db) } as AppEnv;
    t.rowId = 0;
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("evaluateRules metrics", () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    });

    // Each case seeds usage whose metric total is `value`, plus rows that must not count.
    const cases: { logs: LogRow[]; metric: string; period: string; value: number }[] = [
        {
            logs: [
                { cost: 600, createdAt: "2026-10-19 09:00:00" },
                { cost: 400, createdAt: "2026-10-19 11:00:00" },
                { cost: 99_999, createdAt: "2026-10-17 11:00:00" },
            ],
            metric: "daily_cost",
            period: "day",
            value: 1000,
        },
        {
            logs: [
                { cost: 700, createdAt: "2026-10-02 09:00:00" },
                { cost: 300, createdAt: "2026-10-18 11:00:00" },
                { cost: 99_999, createdAt: "2026-09-30 23:59:59" },
            ],
            metric: "monthly_cost",
            period: "month",
            value: 1000,
        },
        {
            logs: [
                { createdAt: "2026-10-19 09:00:00" },
                { createdAt: "2026-10-19 10:00:00" },
                { createdAt: "2026-10-19 11:00:00" },
                { createdAt: "2026-10-16 11:00:00" },
            ],
            metric: "request_count",
            period: "day",
            value: 3,
        },
        {
            logs: [
                { completion: 25, createdAt: "2026-10-19 09:00:00", prompt: 100 },
                { completion: 5, createdAt: "2026-10-19 10:00:00", prompt: 10 },
                { completion: 9000, createdAt: "2026-10-10 10:00:00", prompt: 9000 },
            ],
            metric: "token_count",
            period: "day",
            value: 140,
        },
    ];

    it.each(cases)("measures $metric over a $period as $value", async ({ logs, metric, period, value }) => {
        addLogs(...logs);
        addRule({ id: "at-value", metric, period, threshold: value });
        addRule({ id: "above-value", metric, period, threshold: value + 1 });

        const result = await evaluateRules(t.env, "user-1", undefined, usage());

        // A rule fires when the metric reaches its threshold, not only when it passes it.
        expect(result.notifications).toEqual([expect.objectContaining({ currentValue: value, metric, ruleId: "at-value", threshold: value })]);
    });

    it("counts only the rule owner's usage", async () => {
        addLogs({ createdAt: "2026-10-19 09:00:00" }, { createdAt: "2026-10-19 09:00:00", user: "user-2" }, { createdAt: "2026-10-19 09:00:00", user: "user-2" });
        addRule({ threshold: 2 });

        expect(await notificationsFor()).toEqual([]);
    });

    it("counts usage of every model, not only the one in the request that triggered the evaluation", async () => {
        addLogs({ createdAt: "2026-10-19 09:00:00", model: "model-a" }, { createdAt: "2026-10-19 09:00:00", model: "model-b" });
        addRule({ threshold: 2 });

        expect(await notificationsFor("model-a")).toHaveLength(1);
    });

    it("never fires on a metric it does not know", async () => {
        addLogs({ createdAt: "2026-10-19 09:00:00" });
        addRule({ metric: "carbon_footprint", threshold: 1 });

        expect(await evaluateRules(t.env, "user-1", undefined, usage())).toEqual({ blocked: false, notifications: [] });
    });

    it("does not fire while usage is below the threshold", async () => {
        addRule({ threshold: 1 });

        expect(await evaluateRules(t.env, "user-1", undefined, usage())).toEqual({ blocked: false, notifications: [] });
    });
});

describe("evaluateRules periods", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const countFor = async (period: string, createdAt: string): Promise<number> => {
        addLogs({ createdAt });
        addRule({ period, threshold: 1 });

        const result = await evaluateRules(t.env, "user-1", undefined, usage());

        return result.notifications.length;
    };

    it("reads `hour` as the last 60 minutes when the window crosses midnight", async () => {
        // 00:30 UTC: the hour began at 23:30 the day before, so the date boundary is crossed.
        vi.useFakeTimers({ now: Date.UTC(2026, 9, 19, 0, 30, 0), toFake: ["Date"] });

        expect(await countFor("hour", "2026-10-19 00:10:00")).toBe(1);
        t.db.exec("DELETE FROM usage_log; DELETE FROM notification_rules");
        expect(await countFor("hour", "2026-10-18 22:00:00")).toBe(0);
    });

    it("leaves out a row from earlier the same day than the last hour", async () => {
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

        expect(await countFor("hour", "2026-10-19 09:00:00")).toBe(0);
    });

    it("reads `day` as the last 24 hours", async () => {
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

        expect(await countFor("day", "2026-10-19 11:00:00")).toBe(1);
        t.db.exec("DELETE FROM usage_log; DELETE FROM notification_rules");
        expect(await countFor("day", "2026-10-17 11:00:00")).toBe(0);
    });

    it("treats an unknown period as `day`", async () => {
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

        expect(await countFor("fortnight", "2026-10-19 11:00:00")).toBe(1);
        t.db.exec("DELETE FROM usage_log; DELETE FROM notification_rules");
        expect(await countFor("fortnight", "2026-10-17 11:00:00")).toBe(0);
    });

    it("reads `month` as the calendar month so far", async () => {
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

        expect(await countFor("month", "2026-10-02 00:00:00")).toBe(1);
        t.db.exec("DELETE FROM usage_log; DELETE FROM notification_rules");
        expect(await countFor("month", "2026-09-30 23:59:59")).toBe(0);
    });

    it("counts a row from the 1st of the month in a `month` rule", async () => {
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

        expect(await countFor("month", "2026-10-01 08:00:00")).toBe(1);
    });

    // The window start must be in the stored `created_at` format (a space, not the ISO `T`): as an
    // ISO string it sorts after every row on its own date, so an `hour` rule would only see rows once
    // the hour spans midnight, and a `month` rule would miss the 1st.
    it("counts a row from 30 minutes ago in an `hour` rule on the same date", async () => {
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

        expect(await countFor("hour", "2026-10-19 11:30:00")).toBe(1);
    });

    it("counts a row from 23 hours ago in a `day` rule that shares the window start's date", async () => {
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

        expect(await countFor("day", "2026-10-18 13:00:00")).toBe(1);
    });
});

describe("evaluateRules rule selection", () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
        addLogs({ createdAt: "2026-10-19 09:00:00", model: "model-a" });
    });

    it("ignores inactive rules and other users' rules", async () => {
        addRule({ active: false, threshold: 1 });
        addRule({ threshold: 1, user: "user-2" });

        expect(await evaluateRules(t.env, "user-1", undefined, usage())).toEqual({ blocked: false, notifications: [] });
    });

    it("evaluates a model-scoped rule only for a request on that model", async () => {
        addRule({ id: "scoped", modelFilter: "model-a", threshold: 1 });

        expect(await notificationsFor("model-b")).toEqual([]);
        expect(await notificationsFor("model-a")).toEqual([expect.objectContaining({ ruleId: "scoped" })]);
    });

    it("evaluates a rule without a model filter for any model", async () => {
        addRule({ threshold: 1 });

        expect(await notificationsFor("model-z")).toHaveLength(1);
    });

    it("evaluates every rule independently", async () => {
        addRule({ id: "met", name: "Met", threshold: 1 });
        addRule({ id: "unmet", name: "Unmet", threshold: 5 });
        addRule({ id: "also-met", metric: "token_count", name: "Also met", threshold: 0 });

        const result = await evaluateRules(t.env, "user-1", undefined, usage());

        expect(result.notifications.map((notification) => notification.ruleId).toSorted((a, b) => a.localeCompare(b))).toEqual(["also-met", "met"]);
    });
});

describe("evaluateRules actions", () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
        addLogs({ createdAt: "2026-10-19 09:00:00" });
    });

    it("`notify` reports the firing and blocks nothing", async () => {
        addRule({ action: "notify", id: "r", metric: "request_count", name: "Daily requests", threshold: 1 });

        expect(await evaluateRules(t.env, "user-1", undefined, usage())).toEqual({
            blocked: false,
            notifications: [{ action: "notify", currentValue: 1, firedAt: NOW, metric: "request_count", ruleId: "r", ruleName: "Daily requests", threshold: 1 }],
        });
    });

    it("`notify_and_block` reports the firing and blocks", async () => {
        addRule({ action: "notify_and_block", id: "r", threshold: 1 });

        const result = await evaluateRules(t.env, "user-1", undefined, usage());

        expect(result.blocked).toBe(true);
        expect(result.notifications).toEqual([expect.objectContaining({ action: "notify_and_block", ruleId: "r" })]);
    });

    it("`block` blocks silently", async () => {
        const id = addRule({ action: "block", threshold: 1 });

        const result = await evaluateRules(t.env, "user-1", undefined, usage());

        expect(result).toEqual({ blocked: true, notifications: [] });
        // Silent to the user, but the rule still counts as fired: it must not re-fire within the cooldown.
        expect(lastTriggered(id)).not.toBeNull();
    });

    it("blocks if any one of several firing rules blocks", async () => {
        addRule({ action: "notify", id: "soft", threshold: 1 });
        addRule({ action: "block", id: "hard", threshold: 1 });

        const result = await evaluateRules(t.env, "user-1", undefined, usage());

        expect(result.blocked).toBe(true);
        expect(result.notifications.map((notification) => notification.ruleId)).toEqual(["soft"]);
    });

    it("does not block for a blocking rule that has not reached its threshold", async () => {
        addRule({ action: "block", threshold: 2 });

        const result = await evaluateRules(t.env, "user-1", undefined, usage());

        expect(result.blocked).toBe(false);
    });
});

describe("evaluateRules cooldown", () => {
    // Real clock: the cooldown claim compares against SQLite's own `datetime('now')`.
    beforeEach(() => {
        addLogs({ createdAt: sqliteTime("-1 hours") });
    });

    it("skips a rule that fired within the last hour, even though its threshold is met", async () => {
        addRule({ action: "notify_and_block", threshold: 1, triggered: "-30 minutes" });

        expect(await evaluateRules(t.env, "user-1", undefined, usage())).toEqual({ blocked: false, notifications: [] });
    });

    it("fires again once the hour has passed, and moves the cooldown forward", async () => {
        const id = addRule({ threshold: 1, triggered: "-2 hours" });
        const before = lastTriggered(id)!;

        const result = await evaluateRules(t.env, "user-1", undefined, usage());

        expect(result.notifications).toEqual([expect.objectContaining({ ruleId: id })]);
        expect(lastTriggered(id)! > before).toBe(true);
        expect(lastTriggered(id)! >= sqliteTime("-1 minutes")).toBe(true);
    });

    it("fires a rule once, then stays quiet for the following evaluations", async () => {
        addRule({ action: "notify_and_block", threshold: 1 });

        const first = await evaluateRules(t.env, "user-1", undefined, usage());
        const second = await evaluateRules(t.env, "user-1", undefined, usage());
        const third = await evaluateRules(t.env, "user-1", undefined, usage());

        expect(first.notifications).toHaveLength(1);
        expect(first.blocked).toBe(true);
        expect(second).toEqual({ blocked: false, notifications: [] });
        expect(third).toEqual({ blocked: false, notifications: [] });
    });

    it("does not start a cooldown for a rule that did not fire", async () => {
        const id = addRule({ threshold: 99 });

        await evaluateRules(t.env, "user-1", undefined, usage());

        expect(lastTriggered(id)).toBeNull();
    });

    it("keeps each rule's cooldown separate", async () => {
        addRule({ id: "cooling", threshold: 1, triggered: "-10 minutes" });
        addRule({ id: "ready", threshold: 1 });

        const result = await evaluateRules(t.env, "user-1", undefined, usage());

        expect(result.notifications.map((notification) => notification.ruleId)).toEqual(["ready"]);
    });
});

describe("evaluateRules when the database fails", () => {
    it("lets the request through and logs, rather than throwing into the request path", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const failure = new Error("D1 unavailable");
        const broken = {
            prepare: () => {
                throw failure;
            },
        } as unknown as D1Database;

        await expect(evaluateRules({ USAGE_DB: broken } as AppEnv, "user-1", undefined, usage())).resolves.toEqual({ blocked: false, notifications: [] });
        expect(error).toHaveBeenCalledWith(expect.stringContaining("Rule evaluation failed"), failure);
    });

    it("keeps the firings it already made when a later rule's metric query fails", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
        addLogs({ createdAt: "2026-10-19 09:00:00" });
        addRule({ id: "first", threshold: 1 });

        const real = t.env.USAGE_DB;
        let metricQueries = 0;

        t.env = {
            USAGE_DB: {
                prepare: (sql: string) => {
                    if (sql.includes("FROM usage_log")) {
                        metricQueries += 1;

                        if (metricQueries > 1) throw new Error("D1 unavailable");
                    }

                    return real.prepare(sql);
                },
            },
        } as unknown as AppEnv;
        addRule({ id: "second", metric: "token_count", threshold: 1 });

        const result = await evaluateRules(t.env, "user-1", undefined, usage());

        expect(result.notifications.map((notification) => notification.ruleId)).toHaveLength(1);
        expect(result.notifications[0]!.ruleId).toBe("first");
    });
});
