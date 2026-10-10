/**
 * Claim-once: the one primitive for "this event / delivery / job happens at
 * most once".
 *
 * A claim is a row in `idempotencyClaims` keyed by `(scope, key)`. The first
 * claim of a key wins; every later one, until the claim expires, is refused.
 * Check and insert share one mutation, so two concurrent deliveries of the same
 * key resolve to a single winner. Scopes in use:
 *
 * | scope              | key                      | ttl                           | who                          |
 * | ------------------ | ------------------------ | ----------------------------- | ---------------------------- |
 * | `messenger`        | `<connectionId>:<event>` | {@link MESSENGER_CLAIM_TTL_MS} | `messenger/webhooks.ts`      |
 * | `trigger-webhook`  | `<triggerId>:<sig hex>`  | {@link TRIGGER_CLAIM_TTL_MS}   | `triggers/http.ts`           |
 * | `job`              | `<jobId>`                | {@link JOB_CLAIM_TTL_MS}       | `lib/job-queue.ts` (`once`)  |
 * | `messenger-reply`  | `<threadId>:<messageId>` | {@link MESSENGER_CLAIM_TTL_MS} | `messenger/functions.ts`     |
 *
 * A key must be remembered at least as long as a replay of it could still pass
 * the caller's own freshness check, or a replay could arrive after its claim
 * was purged yet still look fresh — hence each TTL is pinned to the window it
 * guards.
 *
 * ## Leases: a deadline, not a second chance
 *
 * Every claim holds until it expires; a later claim of the key is refused
 * either way. {@link claimLease} additionally sets a DEADLINE for the work:
 * {@link completeClaim} clears it when the work ends. A lease that lapses
 * uncompleted means the holder died mid-run (isolate eviction), and
 * {@link reapLapsedClaims} — every cron tick — runs the claim's `onLapse`
 * compensation (e.g. mark a pending media message failed, so the UI stops
 * spinning and the user can retry) and then clears the lease. The work itself
 * is NEVER re-run: for a paid provider call, "maybe charged twice" is worse
 * than "failed, retry by hand". See `lib/job-once.ts`.
 *
 * Expired rows are ignored by every read (so the purge may lag) and removed by
 * {@link purgeExpiredClaims} from the cron tick. A claim tagged with a `userId`
 * is erased with that user's account (`gdpr/steps/residual-deletion-steps.ts`).
 *
 * Deliberately NOT built on this: `cronRuns` (a per-job slot, not a key seen
 * once) and `persistentStreams.runClaimedAt` / `pollSeq` (compare-and-set on
 * the row the work is about, which needs no second table).
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { patchRow } from "./patch";

/**
 * Messenger events: must outlast the longest freshness window any adapter
 * accepts (WhatsApp's 24h service window, Telegram's 24h retention).
 */
export const MESSENGER_CLAIM_TTL_MS = 25 * 60 * 60 * 1000;

/** Trigger webhooks: must outlast the signed-timestamp window on either side (`lib/crypto.ts`). */
export const TRIGGER_CLAIM_TTL_MS = 15 * 60 * 1000;

/** Queue jobs: well past the queue's retry window (seconds to minutes); a day is plenty. */
export const JOB_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/** Rows deleted per purge call; a full batch reschedules the purge at once. */
export const CLAIM_PURGE_BATCH = 500;

type ClaimCtx = Pick<MutationCtx, "db">;

/** What {@link reapLapsedClaims} schedules when a lease lapses uncompleted: `target(args + { claimKey })`. */
export interface LapseHandler {
    /** JSON of the argument record. */
    args?: string;
    /** `<module>:<export>` of an internal mutation or action. */
    target: string;
}

interface ClaimOptions {
    /** Deadline for the work, after which `onLapse` runs unless the claim was completed. */
    leaseMs?: number;
    onLapse?: LapseHandler;
    ttlMs: number;
    userId?: string;
}

const findClaim = async (ctx: ClaimCtx, scope: string, key: string) =>
    await ctx.db
        .query("idempotencyClaims")
        .withIndex("by_scope_key", (q) => q.eq("scope", scope).eq("key", key))
        .first();

const claim = async (ctx: ClaimCtx, scope: string, key: string, { leaseMs, onLapse, ttlMs, userId }: ClaimOptions): Promise<boolean> => {
    const now = Date.now();
    const existing = await findClaim(ctx, scope, key);

    if (existing) {
        if (existing.expiresAt > now) {
            return false;
        }

        await ctx.db.delete(existing._id);
    }

    await ctx.db.insert("idempotencyClaims", {
        claimedAt: now,
        expiresAt: now + ttlMs,
        key,
        scope,
        ...(leaseMs !== undefined && { leaseExpiresAt: now + leaseMs }),
        ...(leaseMs !== undefined && onLapse !== undefined && { onLapse }),
        ...(userId !== undefined && { userId }),
    });

    return true;
};

/** `true` for the first claim of `(scope, key)` within `ttlMs`, `false` for every later one. */
export const claimOnce = async (ctx: ClaimCtx, scope: string, key: string, ttlMs: number, userId?: string): Promise<boolean> =>
    await claim(ctx, scope, key, { ttlMs, userId });

/** A claim with a deadline for the work; see "Leases" above. */
export const claimLease = async (ctx: ClaimCtx, scope: string, key: string, options: ClaimOptions & { leaseMs: number }): Promise<boolean> =>
    await claim(ctx, scope, key, options);

/** The work ended (returned or threw): clear the deadline, so no lapse handler runs. */
export const completeClaim = async (ctx: ClaimCtx, scope: string, key: string): Promise<void> => {
    const existing = await findClaim(ctx, scope, key);

    if (existing?.leaseExpiresAt === undefined) {
        return;
    }

    await patchRow(ctx.db, existing, { leaseExpiresAt: undefined, onLapse: undefined });
};

/**
 * Give a claim back: the work it guarded did not start (e.g. scheduling it
 * failed), so a sender's retry of the same key must not read as a replay.
 */
export const releaseClaim = async (ctx: ClaimCtx, scope: string, key: string): Promise<void> => {
    const existing = await findClaim(ctx, scope, key);

    if (existing) {
        await ctx.db.delete(existing._id);
    }
};

// ─── Mutations, for callers outside a transaction (HTTP actions, actions) ─────

const vClaimArgs = {
    key: v.string(),
    leaseMs: v.optional(v.number()),
    onLapse: v.optional(v.object({ args: v.optional(v.string()), target: v.string() })),
    scope: v.string(),
    ttlMs: v.number(),
    userId: v.optional(v.string()),
};

/** {@link claimOnce}, or {@link claimLease} when `leaseMs` is given. */
export const claimKey = internalMutation
    .input(vClaimArgs)
    .output(v.boolean())
    .mutation(async ({ args: { key, leaseMs, onLapse, scope, ttlMs, userId }, ctx }) => await claim(ctx, scope, key, { leaseMs, onLapse, ttlMs, userId }));

export const completeKey = internalMutation
    .input({ key: v.string(), scope: v.string() })
    .output(v.null())
    .mutation(async ({ args: { key, scope }, ctx }) => {
        await completeClaim(ctx, scope, key);

        return null;
    });

export const releaseKey = internalMutation
    .input({ key: v.string(), scope: v.string() })
    .output(v.null())
    .mutation(async ({ args: { key, scope }, ctx }) => {
        await releaseClaim(ctx, scope, key);

        return null;
    });

/** Lapsed leases handled per tick; the rest wait a minute. */
export const LAPSE_REAP_BATCH = 50;

/**
 * Leases past their deadline and never completed: schedule each `onLapse`
 * compensation with the claim's key added, then clear the lease so it runs once.
 * The claim itself stays, so the work is still refused. Every cron tick.
 */
export const reapLapsedClaims = internalMutation
    .input({})
    .output(v.number())
    .mutation(async ({ ctx }) => {
        // `gt(0)`: rows without a lease must not match the range.
        const lapsed = await ctx.db
            .query("idempotencyClaims")
            .withIndex("by_leaseExpiresAt", (q) => q.gt("leaseExpiresAt", 0).lte("leaseExpiresAt", ctx.now))
            .take(LAPSE_REAP_BATCH);

        for (const row of lapsed) {
            if (row.onLapse) {
                const args = row.onLapse.args ? (JSON.parse(row.onLapse.args) as Record<string, unknown>) : {};

                await ctx.scheduler.runAfter(0, row.onLapse.target, { ...args, claimKey: row.key });
            }

            await patchRow(ctx.db, row, { leaseExpiresAt: undefined, onLapse: undefined });
        }

        return lapsed.length;
    });

/** Drop expired claims — one bounded batch, rescheduling itself while batches come back full (from the cron tick). */
export const purgeExpiredClaims = internalMutation
    .input({})
    .output(v.number())
    .mutation(async ({ ctx }) => {
        const expired = await ctx.db
            .query("idempotencyClaims")
            .withIndex("by_expiresAt", (q) => q.lt("expiresAt", ctx.now))
            .take(CLAIM_PURGE_BATCH);

        await Promise.all(expired.map(async (row) => await ctx.db.delete(row._id)));

        if (expired.length === CLAIM_PURGE_BATCH) {
            await ctx.scheduler.runAfter(0, internal.lib.claim_once.purgeExpiredClaims, {});
        }

        return expired.length;
    });
