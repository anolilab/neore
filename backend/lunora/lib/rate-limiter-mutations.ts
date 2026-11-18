/**
 * Internal mutations for rate limiting.
 * These are called from action contexts (which don't have ctx.db)
 * via ctx.runMutation so rate limits can be enforced from actions too.
 */
import { v } from "lunorash/server";
import { availableAt, createDbStore } from "lunorash/ratelimit";

import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { createRatelimit, RATE_LIMIT_CONFIGS } from "./rate-limiter";

/**
 * Gives back `count` units that {@link applyLimit} took from a fixed window, for a send that was then refused. The window's
 * remaining count goes up by `count`, capped at its rate. A window that rolled over since the charge is already full, so the
 * refund adds nothing there. Written to the same row the limiter reads (`neore:<key>:<identifier>`, `lunorash/ratelimit`).
 */
export const refundLimitUnits = async (
    ctx: Pick<MutationCtx, "db">,
    { count, identifier, key }: { count: number; identifier: string; key: string },
): Promise<void> => {
    const config = (RATE_LIMIT_CONFIGS as Record<string, (typeof RATE_LIMIT_CONFIGS)[keyof typeof RATE_LIMIT_CONFIGS] | undefined>)[key];

    if (!config) {
        return;
    }

    const store = createDbStore({ db: ctx.db as never });
    const storageKey = `${encodeURIComponent(key)}:${encodeURIComponent(`neore:${key}:${identifier}`)}`;
    const current = availableAt(config, await store.get(storageKey), Date.now());

    await store.set(storageKey, { ts: current.ts, value: Math.min(config.capacity ?? config.rate, current.value + count) });
};

/** The charge {@link applyRateLimit} makes, as a plain function for a mutation that charges in its own transaction. */
export const applyLimit = async (
    ctx: Pick<MutationCtx, "db" | "now">,
    { count, identifier, key, reserve }: { count?: number; identifier: string; key: string; reserve?: boolean },
): Promise<{ ok: boolean; retryAfter: number | undefined }> => {
    // Widened at the lookup, not in the table — `key` arrives from the wire as
    // an already-tiered `<base>:<tier>` string.
    if (!Object.hasOwn(RATE_LIMIT_CONFIGS, key)) {
        return { ok: true, retryAfter: undefined };
    }

    const limiter = createRatelimit(key, ctx.db);
    const config = (RATE_LIMIT_CONFIGS as Record<string, { capacity?: number; rate: number }>)[key]!;
    const units = reserve === true ? Math.min(count ?? 1, config.capacity ?? config.rate) : (count ?? 1);
    const result = await limiter.limit(identifier, { count: units, reserve });

    return {
        ok: result.ok,
        retryAfter: result.ok ? undefined : Math.max(0, result.reset - ctx.now),
    };
};

export const applyRateLimit = internalMutation
    .input({
        count: v.optional(v.number()),
        identifier: v.string(),
        key: v.string(),
        /**
         * Charge for work already done: book the units even past what is left, so the next call is refused. Capped at
         * the window's capacity, which the limiter would otherwise refuse with a throw.
         */
        reserve: v.optional(v.boolean()),
    })
    .mutation(async ({ args, ctx }) => await applyLimit(ctx, args));

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
