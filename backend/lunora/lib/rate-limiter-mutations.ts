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

/** The row the limiter reads for one identifier (`neore:<key>:<identifier>`, `lunorash/ratelimit`), encoded as the store encodes it. */
const limitStorageKey = (key: string, identifier: string): string => `${encodeURIComponent(key)}:${encodeURIComponent(`neore:${key}:${identifier}`)}`;

/**
 * Gives back `count` units that {@link applyLimit} took from the fixed window starting at `windowStart`, for a send that was
 * then refused. The units go back only while that window is still the current one: once it has rolled over, the charge no
 * longer counts against anything, and the new window's own charges must not be credited. Otherwise the remaining count goes
 * up by `count`, capped at the rate.
 */
export const refundLimitUnits = async (
    ctx: Pick<MutationCtx, "db">,
    { count, identifier, key, windowStart }: { count: number; identifier: string; key: string; windowStart: number },
): Promise<void> => {
    const config = (RATE_LIMIT_CONFIGS as Record<string, (typeof RATE_LIMIT_CONFIGS)[keyof typeof RATE_LIMIT_CONFIGS] | undefined>)[key];

    if (!config) {
        return;
    }

    const store = createDbStore({ db: ctx.db as never });
    const storageKey = limitStorageKey(key, identifier);
    const current = availableAt(config, await store.get(storageKey), Date.now());

    if (current.ts !== windowStart) {
        return;
    }

    await store.set(storageKey, { ts: current.ts, value: Math.min(config.capacity ?? config.rate, current.value + count) });
};

/** The charge {@link applyRateLimit} makes, as a plain function for a mutation that charges in its own transaction. */
export const applyLimit = async (
    ctx: Pick<MutationCtx, "db" | "now">,
    { count, identifier, key, reserve }: { count?: number; identifier: string; key: string; reserve?: boolean },
): Promise<{ ok: boolean; retryAfter: number | undefined; windowStart?: number }> => {
    // Widened at the lookup, not in the table — `key` arrives from the wire as
    // an already-tiered `<base>:<tier>` string.
    if (!Object.hasOwn(RATE_LIMIT_CONFIGS, key)) {
        return { ok: true, retryAfter: undefined };
    }

    const limiter = createRatelimit(key, ctx.db);
    const config = (RATE_LIMIT_CONFIGS as Record<string, { capacity?: number; rate: number }>)[key]!;
    const units = reserve === true ? Math.min(count ?? 1, config.capacity ?? config.rate) : (count ?? 1);
    const result = await limiter.limit(identifier, { count: units, reserve });

    if (!result.ok) {
        return { ok: false, retryAfter: Math.max(0, result.reset - ctx.now) };
    }

    // The window the units were taken from: a fixed window's row carries its start after a consume.
    const store = createDbStore({ db: ctx.db as never });
    const row = await store.get(limitStorageKey(key, identifier));

    return { ok: true, retryAfter: undefined, windowStart: row?.ts };
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

/** Gives back the units a charge took for work refused before it ran (a browser action the renderer did not run). */
export const refundRateLimit = internalMutation
    .input({
        count: v.optional(v.number()),
        identifier: v.string(),
        key: v.string(),
    })
    .mutation(async ({ args: { count, identifier, key }, ctx }) => {
        if (!Object.hasOwn(RATE_LIMIT_CONFIGS, key)) {
            return;
        }

        await createRatelimit(key, ctx.db).refund(identifier, count);
    });

/**
 * Gives back one unit a charge took from the window starting at `windowStart`, only while that window is still current (`refundLimitUnits`).
 * A probe that charges and refunds in two steps uses this, so a refund never credits an action charged in a newer window.
 */
export const refundRateLimitWindow = internalMutation
    .input({ identifier: v.string(), key: v.string(), windowStart: v.number() })
    .mutation(async ({ args: { identifier, key, windowStart }, ctx }) => {
        await refundLimitUnits(ctx, { count: 1, identifier, key, windowStart });
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
