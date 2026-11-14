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
 * A row with a negative `value` (debt a `reserve` left) is kept, as the library's own
 * sweep keeps it: concurrent reserves can stack debt past one capacity, so its refill
 * can outlast the retention, and deleting it would forgive the debt.
 *
 * Rows live on the shard whose mutation charged them, so the sweep runs on `__root__`
 * from the cron tick and on each user shard from `lib/shard-housekeeping.ts`.
 */
import type { RateLimitConfig } from "lunorash/ratelimit";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation } from "../_generated/server";
import { RATE_LIMIT_CONFIGS } from "./rate-limiter";

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

export const sweepExpiredRateLimits = internalMutation
    .input({})
    .output(v.number())
    .mutation(async ({ ctx }) => {
        const { page: expired } = await ctx.db.rateLimits.findMany({
            limit: RATE_LIMIT_SWEEP_PAGE,
            orderBy: [{ ts: "asc" }],
            where: { ts: { lt: ctx.now - RATE_LIMIT_RETENTION_MS }, value: { gte: 0 } },
        });

        await Promise.all(expired.map(async (row) => await ctx.db.delete("rateLimits", row._id)));

        if (expired.length === RATE_LIMIT_SWEEP_PAGE) {
            await ctx.scheduler.runAfter(0, internal.lib.rate_limit_sweep.sweepExpiredRateLimits, {});
        }

        return expired.length;
    });
