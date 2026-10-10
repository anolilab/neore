/**
 * A real action cache, not a pass-through.
 *
 * It memoises an action's result by args with a TTL, in its own
 * tables. The first version shimmed it as a pass-through — correct
 * but uncached, which is fine for a migration and not fine to ship: the two
 * heaviest users are LLM `doGenerate`/`doStream` wrappers, where a miss is a paid
 * model call.
 *
 * So this is the component reimplemented over an ordinary Lunora table
 * (`actionCache`, declared in `schema.ts` like every other table — Lunora has no
 * component system to mount it into).
 *
 * ## Two things worth knowing
 *
 * **The key is a hash, not the args.** Call sites pass `JSON.stringify(params)`
 * of a full LLM request, which is routinely tens of kilobytes. Storing that as an
 * indexed column would be wasteful and would hit column-size limits; a SHA-256 of
 * it is fixed-width and indexes cleanly.
 *
 * **Expiry is lazy.** A read past `expiresAt` reports a miss and leaves the row;
 * nothing scans for expired entries on the read path. That keeps reads in a query
 * (no write) and matches how the component behaved. `crons.ts`'s hourly
 * `purgeActionCache` is what actually reclaims the space — without it this table
 * grows for the lifetime of the deployment, and its heaviest writers are LLM
 * responses.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { logger } from "./logger";
import { withoutUndefined } from "./patch";
import { sha256Hex } from "./crypto";

/** Rows read per round. `findMany` requires a size; this is not a ceiling on the work. */
const CACHE_SWEEP_BATCH = 500;

/** Rounds `removeAll` will take before giving up, so a stuck read cannot spin forever. */
const MAX_SWEEP_ROUNDS = 1000;

/** SHA-256 of the args blob, hex. Stable across isolates, unlike a JS hash. */
export const cacheKeyFor = async (name: string, args: string): Promise<string> => await sha256Hex(`${name}\u{0}${args}`);

/**
 * `now` is the caller's clock. A query must not read `Date.now()` itself: a live
 * subscription can re-run it, and each run would answer with a different clock.
 */
export const get = internalQuery
    .input({ key: v.string(), now: v.number() })
    .output(v.union(v.object({ kind: v.literal("miss") }), v.object({ kind: v.literal("hit"), value: v.any() })))
    .query(async ({ args, ctx }) => {
        const row = await ctx.db.actionCache.findFirst({ where: { key: args.key } });

        if (!row || row.expiresAt <= args.now) {
            return { kind: "miss" as const };
        }

        return { kind: "hit" as const, value: row.value };
    });

export const put = internalMutation
    .input({ key: v.string(), name: v.string(), ttl: v.number(), value: v.any() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const expiresAt = ctx.now + args.ttl;

        const existing = await ctx.db.actionCache.findFirst({ where: { key: args.key } });

        if (existing) {
            // A computation can legitimately return `undefined`; a patch refuses it.
            await ctx.db.patch(existing._id, { expiresAt, ...withoutUndefined({ value: args.value }) });

            return null;
        }

        // `name` is stored so `removeAll` can invalidate a whole family without
        // knowing the args that produced each key.
        await ctx.db.insert("actionCache", { expiresAt, key: args.key, name: args.name, value: args.value });

        return null;
    });

export const remove = internalMutation
    .input({ key: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const row = await ctx.db.actionCache.findFirst({ where: { key: args.key } });

        if (row) {
            await ctx.db.delete(row._id);
        }

        return null;
    });

/**
 * Invalidate ONE entry, addressed the way a caller thinks of it.
 *
 * `remove` takes the hashed key, which a caller does not have — the cache
 * accepts `{ name, args }` and hashes internally. Reproducing that
 * keeps the digest in one place: a caller computing its own key is a caller that
 * can silently compute a DIFFERENT one and invalidate nothing.
 */
export const removeByArgs = internalMutation
    .input({ args: v.string(), name: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const key = await cacheKeyFor(args.name, args.args);
        const row = await ctx.db.actionCache.findFirst({ where: { key } });

        if (row) {
            await ctx.db.delete(row._id);
        }

        return null;
    });

/**
 * Invalidate every entry for a cache family — the "the underlying data changed" case.
 *
 * Deletes to exhaustion rather than in one bounded batch. This is the one cache
 * operation where a miss is a correctness bug: leaving entries behind serves
 * stale data for exactly the data that just changed. A single capped read would
 * silently do that past its limit, and the caller cannot tell — this returns
 * nothing it could branch on.
 *
 * Re-reads the first page each round instead of following a cursor, because the
 * rows it just deleted are the ones the cursor would have been anchored to.
 */
export const removeAll = internalMutation
    .input({ name: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        for (let round = 0; round < MAX_SWEEP_ROUNDS; round += 1) {
            const { page: rows } = await ctx.db.actionCache.findMany({ limit: CACHE_SWEEP_BATCH, where: { name: args.name } });

            if (rows.length === 0) {
                return null;
            }

            for (const row of rows) {
                await ctx.db.delete(row._id);
            }
        }

        throw new LunoraError("INTERNAL", `action cache: "${args.name}" still had entries after ${String(MAX_SWEEP_ROUNDS)} sweep rounds`);
    });

/**
 * How long a generation token outlives its last bump. It must exceed the TTL of
 * every entry keyed on it: once the token row expires the scope reads as
 * generation `"0"` again, which is only safe when nothing cached under an older
 * `"0"` can still be alive.
 */
const GENERATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const generationRowName = (name: string): string => `${name}#generation`;

/**
 * The current generation token of one scope (say, one user) of a cache family.
 *
 * Readers put it into their cache args; `bumpGeneration` replaces it, so every
 * entry cached under the old token stops being addressable at once. That is the
 * invalidation for a family whose args cannot be enumerated — a free-form
 * filter, for one — where `removeByArgs` would have to guess every combination.
 */
export const getGeneration = internalQuery
    .input({ name: v.string(), now: v.number(), scope: v.string() })
    .output(v.string())
    .query(async ({ args, ctx }) => {
        const key = await cacheKeyFor(generationRowName(args.name), args.scope);
        const row = await ctx.db.actionCache.findFirst({ where: { key } });

        return row && row.expiresAt > args.now && typeof row.value === "string" ? row.value : "0";
    });

/**
 * Invalidate every entry of one scope by giving it a fresh generation token.
 *
 * A random token rather than a counter: two concurrent bumps that read the same
 * old value would write the same "next" number, and a reader between them could
 * cache stale data under it. Two random tokens never collide.
 */
export const bumpGeneration = internalMutation
    .input({ name: v.string(), scope: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const name = generationRowName(args.name);
        const key = await cacheKeyFor(name, args.scope);
        const expiresAt = ctx.now + GENERATION_TTL_MS;
        const value = crypto.randomUUID();
        const existing = await ctx.db.actionCache.findFirst({ where: { key } });

        if (existing) {
            await ctx.db.patch(existing._id, { expiresAt, value });
        } else {
            await ctx.db.insert("actionCache", { expiresAt, key, name, value });
        }

        return null;
    });

/** Drop expired rows. Called from the cron sweep; expiry itself is lazy. */
export const purgeExpired = internalMutation
    .input({})
    .output(v.number())
    .mutation(async ({ ctx }) => {
        const { page: rows } = await ctx.db.actionCache.findMany({ limit: CACHE_SWEEP_BATCH, where: { expiresAt: { lt: ctx.now } } });

        for (const row of rows) {
            await ctx.db.delete(row._id);
        }

        return rows.length;
    });

/**
 * `ActionCache`, backed by the table above.
 *
 * Was a pass-through shim during the mechanical port — correct but uncached,
 * which is not acceptable to ship: the callers are prompt and skill listing on
 * read-heavy paths.
 *
 * The first constructor argument is the handle the earlier component took.
 * It is ignored, and kept only so the ~6 call sites need no edit.
 */
export class ActionCache<Args = unknown, Result = unknown> {
    readonly #action: unknown;

    readonly #name: string;

    readonly #ttl: number;

    public constructor(_component: unknown, options: { action: unknown; name: string; ttl?: number }) {
        this.#action = options.action;
        this.#name = options.name;
        this.#ttl = options.ttl ?? 60_000;
    }

    /** Cached call. A miss runs the action and stores the result. */
    public async fetch(context: ActionCtx, args: Args): Promise<Result> {
        const key = await cacheKeyFor(this.#name, JSON.stringify(args));
        const cached = await context.runQuery(internal.lib.action_cache.get, { key, now: Date.now() });

        if (cached.kind === "hit") {
            return cached.value as Result;
        }

        const value = await context.runAction(this.#action as never, args as never);

        // A failed cache WRITE must not fail the call. The value is already
        // computed and correct; storing it is an optimisation, and the caller
        // asked for the value, not for the memo.
        //
        // This is not hypothetical: two cached queries warming on the same first
        // paint both write here, one loses the optimistic-concurrency check on
        // `actionCache`, and without this the user's query came back 409.
        try {
            await context.runMutation(internal.lib.action_cache.put, { key, name: this.#name, ttl: this.#ttl, value });
        } catch (error) {
            // Logged, not swallowed silently — a cache that never writes is a
            // performance bug worth seeing, it just isn't a request failure.
            logger.warn(`action cache: could not store "${this.#name}"`, error);
        }

        return value as Result;
    }

    /** Invalidate one entry. */
    public async remove(context: ActionCtx, args: Args): Promise<void> {
        await context.runMutation(internal.lib.action_cache.remove, { key: await cacheKeyFor(this.#name, JSON.stringify(args)) });
    }
}
