import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { RATE_LIMIT_RETENTION_MS, sweepDormantShardRateLimits } from "./rate-limit-sweep";
import { runInShard } from "./shard-context";
import {
    dispatchDormantRateLimitSweeps,
    DISPATCH_BATCH,
    HOUSEKEEPING_HORIZON_MS,
    HOUSEKEEPING_IDLE_INTERVAL_MS,
    needsDormantRateLimitSweep,
    needsHousekeeping,
} from "./shard-housekeeping";

const NOW = 10_000_000_000;

describe("needsHousekeeping", () => {
    it("sweeps a shard never swept", () => {
        expect(needsHousekeeping({ lastActiveAt: NOW - 1000 }, NOW)).toBe(true);
    });

    it("sweeps a shard active since its last sweep", () => {
        expect(needsHousekeeping({ housekeptAt: NOW - 60_000, lastActiveAt: NOW - 1000 }, NOW)).toBe(true);
    });

    it("skips an idle shard swept recently, and sweeps it again after a day", () => {
        expect(needsHousekeeping({ housekeptAt: NOW - 60_000, lastActiveAt: NOW - 120_000 }, NOW)).toBe(false);
        expect(needsHousekeeping({ housekeptAt: NOW - HOUSEKEEPING_IDLE_INTERVAL_MS, lastActiveAt: NOW - 2 * HOUSEKEEPING_IDLE_INTERVAL_MS }, NOW)).toBe(true);
    });

    it("drops a shard idle past the horizon", () => {
        expect(needsHousekeeping({ lastActiveAt: NOW - HOUSEKEEPING_HORIZON_MS - 1 }, NOW)).toBe(false);
    });
});

describe("needsDormantRateLimitSweep", () => {
    it("visits a shard until a sweep has emptied it, and again once it was active after that", () => {
        expect(needsDormantRateLimitSweep({ lastActiveAt: NOW })).toBe(true);
        expect(needsDormantRateLimitSweep({ lastActiveAt: NOW, rateLimitsClearedAt: NOW + 1 })).toBe(false);
        expect(needsDormantRateLimitSweep({ lastActiveAt: NOW + 2, rateLimitsClearedAt: NOW + 1 })).toBe(true);
    });
});

describe("the dormant-shard rate-limit sweep", () => {
    const DORMANT = NOW - HOUSEKEEPING_HORIZON_MS - 24 * 60 * 60 * 1000;

    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
        vi.useRealTimers();
    });

    const census = async (rows: Record<string, unknown>[]): Promise<void> => {
        await harness.run(async (ctx: any) => {
            for (const row of rows) {
                await ctx.db.insert("shardActivity", row);
            }
        });
    };

    interface Scheduled {
        args: Record<string, unknown>;
        path: string;
        shardKey?: string;
    }

    const dispatch = async (args: Record<string, unknown> = {}): Promise<{ dispatched: number; scheduled: Scheduled[] }> =>
        await harness.run(async (ctx: any) => {
            const scheduled: Scheduled[] = [];

            ctx.scheduler.runAfter = async (
                _delay: number,
                reference: { __lunoraRef: string },
                scheduledArgs: Record<string, unknown>,
                options?: { shardKey?: string },
            ) => {
                scheduled.push({ args: scheduledArgs, path: reference.__lunoraRef, shardKey: options?.shardKey });

                return "job";
            };

            const { dispatched } = await ctx.runMutation(dispatchDormantRateLimitSweeps, args);

            return { dispatched, scheduled };
        });

    it("sends the sweep to a dormant shard only, never to one housekeeping still visits or one already emptied", async () => {
        await census([
            { lastActiveAt: DORMANT, shardKey: "dormant" },
            { lastActiveAt: NOW - 60_000, shardKey: "active" },
            { lastActiveAt: NOW - HOUSEKEEPING_HORIZON_MS, shardKey: "at-horizon" },
            { lastActiveAt: DORMANT, rateLimitsClearedAt: DORMANT + 1, shardKey: "emptied" },
        ]);

        const { dispatched, scheduled } = await dispatch();

        expect(dispatched).toBe(1);
        expect(scheduled).toStrictEqual([{ args: {}, path: "lib_rate_limit_sweep:sweepDormantShardRateLimits", shardKey: "dormant" }]);
    });

    it("dispatches one page per run and follows the cursor to the end", async () => {
        await census(
            Array.from({ length: DISPATCH_BATCH + 5 }, (_, index) => {
                return { lastActiveAt: DORMANT - index, shardKey: `user-${index}` };
            }),
        );

        const first = await dispatch();
        const sweeps = (run: { scheduled: Scheduled[] }) => run.scheduled.filter((job) => job.path.endsWith("sweepDormantShardRateLimits"));
        const next = first.scheduled.filter((job) => job.path.endsWith("dispatchDormantRateLimitSweeps"));

        expect(first.dispatched).toBe(DISPATCH_BATCH);
        expect(sweeps(first)).toHaveLength(DISPATCH_BATCH);
        expect(next).toHaveLength(1);
        expect(next[0]!.args).toStrictEqual({ before: NOW - HOUSEKEEPING_HORIZON_MS, cursor: expect.any(String) });

        const second = await dispatch(next[0]!.args);

        expect(second.dispatched).toBe(5);
        expect(second.scheduled.filter((job) => job.path.endsWith("dispatchDormantRateLimitSweeps"))).toStrictEqual([]);

        const visited = new Set([...sweeps(first), ...sweeps(second)].map((job) => job.shardKey));

        expect(visited.size).toBe(DISPATCH_BATCH + 5);
    });

    const sweepOn = async (shardKey: string): Promise<{ cleared: boolean; clearedAt: number | undefined; deleted: number; left: number }> =>
        await runInShard(
            shardKey,
            async () =>
                await harness.run(async (ctx: any) => {
                    ctx.scheduler.runAfter = async () => "job";

                    const result = await ctx.runMutation(sweepDormantShardRateLimits, {});
                    const row = await ctx.db.shardActivity.findFirst({ where: { shardKey } });

                    const left = await ctx.db.query("rateLimits").collect();

                    return { ...result, clearedAt: row?.rateLimitsClearedAt, left: left.length };
                }),
        );

    it("deletes the shard's expired rows and marks the census once nothing is left", async () => {
        await census([{ lastActiveAt: DORMANT, shardKey: "dormant" }]);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("rateLimits", { key: "old", ts: NOW - RATE_LIMIT_RETENTION_MS - 1, value: 1 });
        });

        expect(await sweepOn("dormant")).toStrictEqual({ cleared: true, clearedAt: NOW, deleted: 1, left: 0 });
    });

    it("leaves the census unmarked while a row is still inside its window, so the shard is visited again", async () => {
        await census([{ lastActiveAt: DORMANT, shardKey: "dormant" }]);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("rateLimits", { key: "old", ts: NOW - RATE_LIMIT_RETENTION_MS - 1, value: 1 });
            await ctx.db.insert("rateLimits", { key: "live", ts: NOW - 1000, value: 1 });
        });

        expect(await sweepOn("dormant")).toStrictEqual({ cleared: false, clearedAt: undefined, deleted: 1, left: 1 });
    });
});
