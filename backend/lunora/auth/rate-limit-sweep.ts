/**
 * Retention for `rateLimit`, better-auth's limiter store for `/api/auth/*`: one `.global()`
 * row per client address and path, updated in place and never deleted.
 *
 * better-auth resets a row's count once `lastRequest` is older than the path's window, so a
 * row past the longest window reads exactly like a missing one. The longest window here is a
 * minute (`AUTH_RATE_LIMIT_CUSTOM_RULES` and better-auth's defaults); a day leaves room for
 * any plugin rule. Runs on `__root__` only: the table is in D1, the same from every shard.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation } from "../_generated/server";

/** A row untouched this long is outside every auth limiter window. */
export const AUTH_RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Rows deleted per run; a full page schedules the next one. */
export const AUTH_RATE_LIMIT_SWEEP_PAGE = 200;

export const sweepExpiredAuthRateLimits = internalMutation
    .input({})
    .output(v.number())
    .mutation(async ({ ctx }) => {
        const { page: expired } = await ctx.db.rateLimit.findMany({
            limit: AUTH_RATE_LIMIT_SWEEP_PAGE,
            orderBy: [{ lastRequest: "asc" }],
            where: { lastRequest: { lt: ctx.now - AUTH_RATE_LIMIT_RETENTION_MS } },
        });

        await Promise.all(expired.map(async (row) => await ctx.db.delete("rateLimit", row._id)));

        if (expired.length === AUTH_RATE_LIMIT_SWEEP_PAGE) {
            await ctx.scheduler.runAfter(0, internal.auth.rate_limit_sweep.sweepExpiredAuthRateLimits, {});
        }

        return expired.length;
    });
