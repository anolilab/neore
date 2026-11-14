/**
 * The rate-limit retention sweeps: `rateLimits` (our limits, `lib/rate-limit-sweep.ts`) and
 * better-auth's `rateLimit` (`auth/rate-limit-sweep.ts`). Rows past the retention go, live rows
 * stay, and a full page schedules the next one.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { AUTH_RATE_LIMIT_RETENTION_MS, AUTH_RATE_LIMIT_SWEEP_PAGE, sweepExpiredAuthRateLimits } from "../auth/rate-limit-sweep";
import schema from "../schema";
import { DAY, Ratelimit } from "./rate-limiter";
import { RATE_LIMIT_RETENTION_MS, RATE_LIMIT_SWEEP_PAGE, debtSettledAt, retentionOf, SLOWEST_REFILL_PER_MS, sweepExpiredRateLimits } from "./rate-limit-sweep";

const NOW = 1_800_000_000_000;

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

interface Table {
    page: number;
    retention: number;
    row: (key: string, at: number) => Record<string, unknown>;
    sweep: unknown;
    table: "rateLimit" | "rateLimits";
    target: unknown;
}

const TABLES: Table[] = [
    {
        page: RATE_LIMIT_SWEEP_PAGE,
        retention: RATE_LIMIT_RETENTION_MS,
        row: (key, at) => {
            return { key, ts: at, value: 1 };
        },
        sweep: sweepExpiredRateLimits,
        table: "rateLimits",
        target: internal.lib.rate_limit_sweep.sweepExpiredRateLimits,
    },
    {
        page: AUTH_RATE_LIMIT_SWEEP_PAGE,
        retention: AUTH_RATE_LIMIT_RETENTION_MS,
        row: (key, at) => {
            return { count: 1, key, lastRequest: at };
        },
        sweep: sweepExpiredAuthRateLimits,
        table: "rateLimit",
        target: internal.auth.rate_limit_sweep.sweepExpiredAuthRateLimits,
    },
];

describe.each(TABLES)("$table sweep", ({ page, retention, row, sweep, table, target }) => {
    const insert = async (keys: string[], at: number): Promise<void> => {
        await harness.run(async (ctx: any) => {
            for (const key of keys) {
                await ctx.db.insert(table, row(key, at));
            }
        });
    };

    const run = async (): Promise<{ deleted: number; keys: string[]; scheduled: unknown[] }> =>
        await harness.run(async (ctx: any) => {
            const scheduled: unknown[] = [];

            ctx.scheduler.runAfter = async (_delay: number, reference: unknown) => {
                scheduled.push(reference);
            };

            const deleted = await ctx.runMutation(sweep, {});
            const rows = await ctx.db.query(table).collect();

            return { deleted, keys: rows.map((r: { key: string }) => r.key).toSorted((a: string, b: string) => a.localeCompare(b)), scheduled };
        });

    it("deletes rows past the retention and keeps live ones, without rescheduling a partial page", async () => {
        await insert(["expired"], NOW - retention - 1);
        await insert(["edge", "live"], NOW - retention + 1);

        await expect(run()).resolves.toStrictEqual({ deleted: 1, keys: ["edge", "live"], scheduled: [] });
    });

    it("schedules the next page when a page comes back full", async () => {
        const expired = Array.from({ length: page + 1 }, (_, index) => `old-${String(index)}`);

        await insert(expired, NOW - retention - 1);
        await insert(["live"], NOW);

        const first = await run();

        expect(first.deleted).toBe(page);
        expect(first.scheduled).toStrictEqual([target]);
        expect(first.keys).toHaveLength(2);
        expect(first.keys).toContain("live");

        await expect(run()).resolves.toStrictEqual({ deleted: 1, keys: ["live"], scheduled: [] });
    });
});

describe("rateLimits sweep and reserve debt", () => {
    it("keeps a row while its debt could still be refilling, and deletes it once even the slowest limit has refilled it", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("rateLimits", { key: "debt", ts: NOW - RATE_LIMIT_RETENTION_MS - 1, value: -1800 });
            await ctx.db.insert("rateLimits", { key: "paid", ts: NOW - RATE_LIMIT_RETENTION_MS - 1, value: 0 });
            // 144,000 seconds: more than 30 days of the premium daily limit, which a burst of capped reserves can reach.
            await ctx.db.insert("rateLimits", { key: "deep", ts: NOW - 40 * DAY, value: -144_000 });
            await ctx.db.insert("rateLimits", { key: "settled", ts: NOW - RATE_LIMIT_RETENTION_MS - 1800 / SLOWEST_REFILL_PER_MS - 1, value: -1800 });
        });

        const keys = await harness.run(async (ctx: any) => {
            await ctx.runMutation(sweepExpiredRateLimits, {});

            const rows: { key: string }[] = await ctx.db.query("rateLimits").collect();

            return rows.map((row) => row.key);
        });

        expect(keys.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["debt", "deep"]);
    });
});

describe("rateLimits sweep past a page of rows still in debt", () => {
    it("moves its cursor past them and reaches a settled row behind them", async () => {
        // Settled: one unit of debt, older than the retention plus that unit's refill at the slowest rate.
        const settledAt = NOW - RATE_LIMIT_RETENTION_MS - 2 / SLOWEST_REFILL_PER_MS;

        await harness.run(async (ctx: any) => {
            for (let index = 0; index < RATE_LIMIT_SWEEP_PAGE; index += 1) {
                // Older than the settled row, and owing far more than the slowest limit refills by now.
                await ctx.db.insert("rateLimits", { key: `owed-${String(index)}`, ts: settledAt - RATE_LIMIT_SWEEP_PAGE + index, value: -1_000_000_000 });
            }

            await ctx.db.insert("rateLimits", { key: "settled", ts: settledAt, value: -1 });
        });

        const sweep = async (args: Record<string, string>): Promise<{ next: Record<string, string> | undefined }> =>
            await harness.run(async (ctx: any) => {
                let next: Record<string, string> | undefined;

                ctx.scheduler.runAfter = async (_delay: number, _reference: unknown, nextArgs: Record<string, string>) => {
                    next = nextArgs;
                };

                await ctx.runMutation(sweepExpiredRateLimits, args);

                return { next };
            });

        const first = await sweep({});

        expect(first.next?.debtCursor).toBeDefined();

        await sweep(first.next ?? {});

        const keys = await harness.run(async (ctx: any) => {
            const rows: { key: string }[] = await ctx.db.query("rateLimits").collect();

            return rows.map((row) => row.key);
        });

        expect(keys).toHaveLength(RATE_LIMIT_SWEEP_PAGE);
        expect(keys).not.toContain("settled");
    });
});

describe("debtSettledAt", () => {
    it("adds the debt's refill at the slowest configured rate to the retention", () => {
        expect(debtSettledAt({ ts: 0, value: -10 })).toBe(RATE_LIMIT_RETENTION_MS + 10 / SLOWEST_REFILL_PER_MS);
    });
});

describe("retentionOf", () => {
    it("is three days for the longest configured limit", () => {
        expect(RATE_LIMIT_RETENTION_MS).toBe(3 * DAY);
    });

    it("covers the window and the refill of a full reserve debt", () => {
        expect(retentionOf(Ratelimit.fixedWindow(5, DAY))).toBe(3 * DAY);
        expect(retentionOf(Ratelimit.tokenBucket(10, 1000, 20))).toBe(4000);
        expect(retentionOf(Ratelimit.slidingWindow(10, 1000))).toBe(3000);
    });
});
