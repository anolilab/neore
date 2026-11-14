import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { RATE_LIMIT_RETENTION_MS, RATE_LIMIT_SWEEP_PAGE, sweepDormantShardRateLimits, sweepExpiredRateLimits } from "./rate-limit-sweep";
import { createRatelimit, getRateLimitKey } from "./rate-limiter";
import { runInShard } from "./shard-context";
import {
    dispatchDormantRateLimitSweeps,
    DISPATCH_BATCH,
    HOUSEKEEPING_HORIZON_MS,
    HOUSEKEEPING_IDLE_INTERVAL_MS,
    markRateLimitsPending,
    needsHousekeeping,
} from "./shard-housekeeping";

const enqueued = vi.hoisted(() => [] as { args: Record<string, unknown>; options: { delayMs?: number; shardKey?: string }; path: string }[]);

vi.mock(
    import("./job-queue"),
    () =>
        ({
            enqueueJob: async (reference: { __lunoraRef: string }, args: Record<string, unknown>, options: { delayMs?: number; shardKey?: string } = {}) => {
                enqueued.push({ args, options, path: reference.__lunoraRef });
            },
        }) as never,
);

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

describe("the dormant-shard rate-limit sweep", () => {
    const DORMANT = NOW - HOUSEKEEPING_HORIZON_MS - 24 * 60 * 60 * 1000;

    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
        harness = lunoraTest(schema as never);
        enqueued.length = 0;
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

    const sweeps = (run: { scheduled: Scheduled[] }) => run.scheduled.filter((job) => job.path.endsWith("sweepDormantShardRateLimits"));
    const hops = (run: { scheduled: Scheduled[] }) => run.scheduled.filter((job) => job.path.endsWith("dispatchDormantRateLimitSweeps"));

    it("sends the sweep to a flagged dormant shard only, never to one housekeeping still visits or one already emptied", async () => {
        await census([
            { lastActiveAt: DORMANT, rateLimitsPending: true, shardKey: "dormant" },
            { lastActiveAt: NOW - 60_000, rateLimitsPending: true, shardKey: "active" },
            { lastActiveAt: NOW - HOUSEKEEPING_HORIZON_MS, rateLimitsPending: true, shardKey: "at-horizon" },
            { lastActiveAt: DORMANT, rateLimitsPending: false, shardKey: "emptied" },
            { lastActiveAt: DORMANT, shardKey: "never-charged" },
        ]);

        const { dispatched, scheduled } = await dispatch();

        expect(dispatched).toBe(1);
        expect(scheduled).toStrictEqual([{ args: {}, path: "lib_rate_limit_sweep:sweepDormantShardRateLimits", shardKey: "dormant" }]);
    });

    it("reads only flagged rows: a full page of emptied shards ahead of a flagged one does not hide it", async () => {
        await census([
            ...Array.from({ length: DISPATCH_BATCH }, (_, index) => {
                return { lastActiveAt: DORMANT - 1000 - index, rateLimitsPending: false, shardKey: `emptied-${index}` };
            }),
            { lastActiveAt: DORMANT, rateLimitsPending: true, shardKey: "flagged" },
        ]);

        const run = await dispatch();

        expect(sweeps(run).map((job) => job.shardKey)).toStrictEqual(["flagged"]);
        expect(hops(run)).toStrictEqual([]);
    });

    it("pages by (lastActiveAt, id): every flagged shard is visited, through ties and a shard turning active between pages", async () => {
        await census(
            Array.from({ length: DISPATCH_BATCH + 5 }, (_, index) => {
                return { lastActiveAt: DORMANT - (index % 3), rateLimitsPending: true, shardKey: `user-${index}` };
            }),
        );

        const first = await dispatch();

        expect(first.dispatched).toBe(DISPATCH_BATCH);
        expect(hops(first)).toHaveLength(1);
        expect(hops(first)[0]!.args).toStrictEqual({
            after: { id: expect.any(String), lastActiveAt: expect.any(Number) },
            before: NOW - HOUSEKEEPING_HORIZON_MS,
        });

        // A shard from the first page comes back: it leaves the dormant range, which an offset cursor would turn into a skipped shard.
        await harness.run(async (ctx: any) => {
            const { shardActivity } = ctx.db;
            const row = await shardActivity.findFirst({ where: { shardKey: sweeps(first)[0]!.shardKey } });

            await ctx.db.patch("shardActivity", row._id, { lastActiveAt: NOW });
        });

        const second = await dispatch(hops(first)[0]!.args);

        expect(second.dispatched).toBe(5);
        expect(hops(second)).toStrictEqual([]);
        expect(new Set([...sweeps(first), ...sweeps(second)].map((job) => job.shardKey)).size).toBe(DISPATCH_BATCH + 5);
    });

    const pendingOf = async (shardKey: string): Promise<boolean | undefined> =>
        await harness.run(async (ctx: any) => {
            const row = await ctx.db.shardActivity.findFirst({ where: { shardKey } });

            return row?.rateLimitsPending;
        });

    const sweepOn = async (shardKey: string): Promise<{ cleared: boolean; deleted: number; left: number; pending: boolean | undefined }> => {
        const result = await runInShard(
            shardKey,
            async () =>
                await harness.run(async (ctx: any) => {
                    ctx.scheduler.runAfter = async () => "job";

                    const swept = await ctx.runMutation(sweepDormantShardRateLimits, {});
                    const left = await ctx.db.query("rateLimits").collect();

                    return { ...swept, left: left.length };
                }),
        );

        return { ...result, pending: await pendingOf(shardKey) };
    };

    it("deletes the shard's expired rows and turns the flag off once nothing is left", async () => {
        await census([{ lastActiveAt: DORMANT, rateLimitsPending: true, shardKey: "dormant" }]);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("rateLimits", { key: "old", ts: NOW - RATE_LIMIT_RETENTION_MS - 1, value: 1 });
        });

        expect(await sweepOn("dormant")).toStrictEqual({ cleared: true, deleted: 1, left: 0, pending: false });
    });

    it("keeps the flag on while a row is still inside its window, so the shard is visited again", async () => {
        await census([{ lastActiveAt: DORMANT, rateLimitsPending: true, shardKey: "dormant" }]);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("rateLimits", { key: "old", ts: NOW - RATE_LIMIT_RETENTION_MS - 1, value: 1 });
            await ctx.db.insert("rateLimits", { key: "live", ts: NOW - 1000, value: 1 });
        });

        expect(await sweepOn("dormant")).toStrictEqual({ cleared: false, deleted: 1, left: 1, pending: true });
    });

    it("visits an emptied shard again once a charge adds a row, though the charge did not move lastActiveAt", async () => {
        await census([{ lastActiveAt: DORMANT, rateLimitsPending: true, shardKey: "dormant" }]);

        const swept = await sweepOn("dormant");
        const idle = await dispatch();

        expect(swept.pending).toBe(false);
        expect(idle.dispatched).toBe(0);

        // A guest's post on the owner's shard: charged there, with no activity note.
        await runInShard("dormant", async () => {
            await harness.run(async (ctx: any) => {
                await createRatelimit(getRateLimitKey("guest/message", "public"), ctx.db).limit("share:link");
            });
        });

        expect(await pendingOf("dormant")).toBe(true);
        const run = await dispatch();

        expect(sweeps(run).map((job) => job.shardKey)).toStrictEqual(["dormant"]);
    });

    it("settles the flag in the continuation of a dormant sweep that needed more than one page", async () => {
        await census([{ lastActiveAt: DORMANT, rateLimitsPending: true, shardKey: "dormant" }]);
        await harness.run(async (ctx: any) => {
            for (let index = 0; index <= RATE_LIMIT_SWEEP_PAGE; index += 1) {
                await ctx.db.insert("rateLimits", { key: `old-${index}`, ts: NOW - RATE_LIMIT_RETENTION_MS - 1 - index, value: 1 });
            }
        });

        const next: Record<string, unknown>[] = [];
        const runOnShard = async (run: (ctx: any) => Promise<unknown>) =>
            await runInShard(
                "dormant",
                async () =>
                    await harness.run(async (ctx: any) => {
                        ctx.scheduler.runAfter = async (_delay: number, _reference: unknown, args: Record<string, unknown>) => {
                            next.push(args);

                            return "job";
                        };

                        return await run(ctx);
                    }),
            );

        expect(await runOnShard(async (ctx) => await ctx.runMutation(sweepDormantShardRateLimits, {}))).toStrictEqual({
            cleared: false,
            deleted: RATE_LIMIT_SWEEP_PAGE,
        });
        expect(await pendingOf("dormant")).toBe(true);
        expect(next).toStrictEqual([{ dormant: true }]);

        expect(await runOnShard(async (ctx) => await ctx.runMutation(sweepExpiredRateLimits, next[0]))).toBe(1);
        expect(await pendingOf("dormant")).toBe(false);
    });

    it("retries a census write that failed after a charge added a row, so the flag still goes on", async () => {
        await census([{ lastActiveAt: DORMANT, rateLimitsPending: false, shardKey: "dormant" }]);

        await runInShard("dormant", async () => {
            await harness.run(async (ctx: any) => {
                // The charge's own table works; the census read beside it fails.
                const database = new Proxy(ctx.db, {
                    get: (target, property) => {
                        if (property === "shardActivity") {
                            return {
                                findFirst: async () => {
                                    throw new Error("D1 unavailable");
                                },
                            };
                        }

                        const value: unknown = Reflect.get(target, property, target);

                        return typeof value === "function" ? value.bind(target) : value;
                    },
                });

                const { ok } = await createRatelimit(getRateLimitKey("guest/message", "public"), database).limit("share:link");

                expect(ok).toBe(true);
            });
        });

        expect(await pendingOf("dormant")).toBe(false);
        expect(enqueued).toStrictEqual([
            {
                args: { shardKey: "dormant" },
                options: { delayMs: expect.any(Number), shardKey: "dormant" },
                path: "lib_shard_housekeeping:markRateLimitsPending",
            },
        ]);

        await runInShard("dormant", async () => {
            await harness.run(async (ctx: any) => await ctx.runMutation(markRateLimitsPending, enqueued[0]!.args));
        });

        expect(await pendingOf("dormant")).toBe(true);
    });
});
