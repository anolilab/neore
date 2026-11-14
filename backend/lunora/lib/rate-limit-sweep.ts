/**
 * Retention for `rateLimits`, the store behind every `@lunora/ratelimit` limit here
 * (`lib/rate-limiter.ts`, the guest-link limits in `chat/guest-links.ts`).
 *
 * The store upserts one row per limit name and identifier and never deletes it. The
 * library does evict a few stale rows of the SAME limit on each consume, so a key
 * nobody charges again (a guest's address, a one-off identifier, a renamed limit)
 * stays forever. This sweep deletes every row whose last write is older than the
 * longest retention of any configured limit: past that point the library would
 * read the row as a full bucket, so deleting it changes no decision.
 *
 * A row with a negative `value` (debt a `reserve` left) is kept past that, as the
 * library's own sweep keeps it: concurrent reserves can stack debt past one capacity,
 * so its refill can outlast the retention. It goes once its debt has refilled (`debtSettledAt`).
 *
 * Rows live on the shard whose mutation charged them, so the sweep runs on `__root__`
 * from the cron tick, on each active user shard from `lib/shard-housekeeping.ts`, and on
 * each dormant one, alone, through {@link sweepDormantShardRateLimits}.
 */
import type { RateLimitConfig } from "lunorash/ratelimit";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { RATE_LIMIT_CONFIGS } from "./rate-limiter";
import { settleRateLimitsPending } from "./shard-housekeeping";

/** Rows deleted per run; a full page schedules the next one. */
export const RATE_LIMIT_SWEEP_PAGE = 200;

/**
 * How long `@lunora/ratelimit` keeps a row before its own sweep may evict it: the
 * period times (2 + capacity / rate). That covers the window itself and the refill
 * of one capacity of debt, so a row this old with a non-negative value reads as a
 * full bucket.
 */
export const retentionOf = (config: RateLimitConfig): number => {
    const capacity = config.kind === "sliding window" ? config.rate : (config.capacity ?? config.rate);

    return config.period * (2 + capacity / config.rate);
};

/** The longest retention of any configured limit: a row older than this is outside every window. */
export const RATE_LIMIT_RETENTION_MS = Math.max(...Object.values(RATE_LIMIT_CONFIGS as Record<string, RateLimitConfig>).map((config) => retentionOf(config)));

/**
 * The slowest refill of any configured limit, in units per millisecond. A row's storage key does not say which limit
 * it belongs to, so a row in debt is kept until even this rate would have paid its debt back.
 */
export const SLOWEST_REFILL_PER_MS = Math.min(
    ...Object.values(RATE_LIMIT_CONFIGS as Record<string, RateLimitConfig>).map((config) => config.rate / config.period),
);

/** When a row in debt reads as a full bucket under every limit: its retention plus the time its debt takes to refill. */
export const debtSettledAt = (row: { ts: number; value: number }): number => row.ts + RATE_LIMIT_RETENTION_MS + -row.value / SLOWEST_REFILL_PER_MS;

/**
 * One run of the sweep on the calling shard: a page of expired rows and a page of settled debt go, and a run that did not
 * reach the end schedules {@link sweepExpiredRateLimits} to continue. Returns the rows deleted. Also run on its own on a
 * dormant shard (`lib/shard-housekeeping.ts`).
 */
export const sweepRateLimitPage = async (ctx: Pick<MutationCtx, "db" | "now" | "scheduler">, debtCursor: string | undefined): Promise<number> => {
    const cutoff = ctx.now - RATE_LIMIT_RETENTION_MS;
    const [{ page: expired }, inDebt] = await Promise.all([
        ctx.db.rateLimits.findMany({ limit: RATE_LIMIT_SWEEP_PAGE, orderBy: [{ ts: "asc" }], where: { ts: { lt: cutoff }, value: { gte: 0 } } }),
        ctx.db.rateLimits.findMany({
            cursor: debtCursor,
            limit: RATE_LIMIT_SWEEP_PAGE,
            orderBy: [{ ts: "asc" }],
            where: { ts: { lt: cutoff }, value: { lt: 0 } },
        }),
    ]);
    const settled = inDebt.page.filter((row) => debtSettledAt(row) < ctx.now);
    const rows = [...expired, ...settled];

    await Promise.all(rows.map(async (row) => await ctx.db.delete("rateLimits", row._id)));

    const moreDebt = !inDebt.isDone && inDebt.continueCursor !== null && inDebt.continueCursor !== undefined;

    if (expired.length === RATE_LIMIT_SWEEP_PAGE || moreDebt) {
        await ctx.scheduler.runAfter(
            0,
            internal.lib.rate_limit_sweep.sweepExpiredRateLimits,
            moreDebt ? { debtCursor: inDebt.continueCursor ?? undefined } : {},
        );
    }

    return rows.length;
};

export const sweepExpiredRateLimits = internalMutation
    // Where the rows still in debt left off: each run moves past them, so rows still owed can't hide settled ones behind them.
    .input({ debtCursor: v.optional(v.string().max(1024)) })
    .output(v.number())
    .mutation(async ({ args: { debtCursor }, ctx }) => await sweepRateLimitPage(ctx, debtCursor));

/**
 * On a dormant user shard (`dispatchDormantRateLimitSweeps` in `lib/shard-housekeeping.ts`): the sweep alone. When it leaves
 * the table empty, the census flag `rateLimitsPending` goes off and the daily dispatch skips this shard until activity or a
 * charge sets it again. A row still inside its window, or a full page the sweep continues on its own, keeps the flag on,
 * so the shard is visited again the next day.
 */
export const sweepDormantShardRateLimits = internalMutation
    .input({})
    .output(v.object({ cleared: v.boolean(), deleted: v.number() }))
    .mutation(async ({ ctx }) => {
        const deleted = await sweepRateLimitPage(ctx, undefined);

        return { cleared: await settleRateLimitsPending(ctx), deleted };
    });
