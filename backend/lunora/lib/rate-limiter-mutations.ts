/**
 * Internal mutations for rate limiting.
 * These are called from action contexts (which don't have ctx.db)
 * via ctx.runMutation so rate limits can be enforced from actions too.
 */
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { createRatelimit, RATE_LIMIT_CONFIGS } from "./rate-limiter";

export const applyRateLimit = internalMutation
    .input({
        count: v.optional(v.number()),
        identifier: v.string(),
        key: v.string(),
    })
    .mutation(async ({ args: { count, identifier, key }, ctx }) => {
        // Widened at the lookup, not in the table — `key` arrives from the wire as
        // an already-tiered `<base>:<tier>` string.
        if (!Object.hasOwn(RATE_LIMIT_CONFIGS, key)) {
            return { ok: true, retryAfter: undefined };
        }

        const limiter = createRatelimit(key, ctx.db);
        const result = await limiter.limit(identifier, { count: count ?? 1 });

        return {
            ok: result.ok,
            retryAfter: result.ok ? undefined : Math.max(0, result.reset - ctx.now),
        };
    });

export const resetRateLimit = internalMutation
    .input({
        identifier: v.string(),
        key: v.string(),
    })
    .mutation(async ({ args: { identifier, key }, ctx }) => {
        // Widened at the lookup, not in the table — `key` arrives from the wire as
        // an already-tiered `<base>:<tier>` string.
        if (!Object.hasOwn(RATE_LIMIT_CONFIGS, key)) {
            return;
        }

        const limiter = createRatelimit(key, ctx.db, "open");

        await limiter.resetUsedTokens(identifier);
    });
