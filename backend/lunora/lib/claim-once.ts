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
 * | `trigger-delivery` | `<triggerId>:<event uuid>:<body sha256>` | {@link TRIGGER_DELIVERY_CLAIM_TTL_MS} | `triggers/http.ts` (`gitlab-token`) |
 * | `job`              | `<jobId>`                | {@link JOB_CLAIM_TTL_MS}       | `lib/job-queue.ts` (`once`)  |
 * | `messenger-reply`  | `<threadId>:<messageId>` | {@link MESSENGER_CLAIM_TTL_MS} | `messenger/functions.ts`     |
 * | `messenger-ai-disclosure` | `<threadId>`      | {@link AI_DISCLOSURE_CLAIM_TTL_MS} | `messenger/functions.ts` |
 * | `switch`           | `<userId>:<threadId>:<clientId>` | 10 min (`AGENT_SWITCH_CLAIM_TTL_MS`) | `chat/agent-switch.ts` |
 * | `daily-charge`     | `<requestId>`            | 24 h                          | `chat/daily-charge.ts`       |
 * | `video-charge`     | `<requestId>`            | 24 h                          | `workflow/video-billing.ts`  |
 * | `video-reservation` | `<requestId>`            | 24 h                          | `auth/billing.ts`            |
 * | `posthog-retry-scheduled` / `-started` / `-outcome` / `-erased` / `-deferred` | `<requestId>:<chain>:<attempt>` (`-erased`: `:<deleted\|no_profile>`, `-deferred`: `:<n>` appended; `posthog-retry-chain`: `<requestId>:<failureId>`) | 14 days (`-lease`: 10 min) | `gdpr/posthog-retry.ts` (not user-tagged: erasing the account must not reopen a finished attempt) |
 * | `gdpr-deletion-confirmed-email` | `<requestId>`  | 14 days; kept when the send throws | `gdpr/posthog-retry.ts`, `gdpr/workflows/deletion-workflow.ts` (one scope: whichever path sends first wins) |
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
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { patchRow } from "./patch";

/**
 * Messenger events: must outlast the longest freshness window any adapter
 * accepts (WhatsApp's 24h service window, Telegram's 24h retention).
 */
export const MESSENGER_CLAIM_TTL_MS = 25 * 60 * 60 * 1000;

/**
 * A chat's AI disclosure, sent once with its first reply. Effectively forever:
 * a re-disclosure is harmless but noisy, and the row is tagged with the owner,
 * so account deletion clears it.
 */
export const AI_DISCLOSURE_CLAIM_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** Trigger webhooks: must outlast the signed-timestamp window on either side (`lib/crypto.ts`). */
export const TRIGGER_CLAIM_TTL_MS = 15 * 60 * 1000;

/**
 * A `gitlab-token` trigger's deliveries (`triggers/http.ts`): GitLab sends no timestamp, so no window ends
 * the replay risk, and the claim must outlast any trigger. Ten years, like {@link AI_DISCLOSURE_CLAIM_TTL_MS},
 * is effectively forever while staying a finite `expiresAt`, so {@link purgeExpiredClaims} still reaps it.
 * It is cleared sooner by {@link releaseClaimsWithPrefix} when the trigger is deleted, and with the account
 * (the claim is tagged with the owner).
 */
export const TRIGGER_DELIVERY_CLAIM_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** The scope of those claims; their keys start with the trigger id, which is how a deleted trigger's are found. */
export const TRIGGER_DELIVERY_SCOPE = "trigger-delivery";

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

const findClaim = async (ctx: Pick<QueryCtx, "db">, scope: string, key: string) =>
    await ctx.db
        .query("idempotencyClaims")
        .withIndex("by_scope_key", (q) => q.eq("scope", scope).eq("key", key))
        .first();

/**
 * Takes the claim and returns its `claimedAt`, the fence {@link releaseClaim}
 * checks, or `null` when the key is held. A claim can only be taken again after
 * the previous one expired, so each acquisition has a `claimedAt` of its own.
 */
const claimFence = async (ctx: ClaimCtx, scope: string, key: string, { leaseMs, onLapse, ttlMs, userId }: ClaimOptions): Promise<number | null> => {
    const now = Date.now();
    const existing = await findClaim(ctx, scope, key);

    if (existing) {
        if (existing.expiresAt > now) {
            return null;
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

    return now;
};

const claim = async (ctx: ClaimCtx, scope: string, key: string, options: ClaimOptions): Promise<boolean> =>
    (await claimFence(ctx, scope, key, options)) !== null;

/** `true` while an unexpired claim for `(scope, key)` exists. Reads only, so a caller can decide before it acts. */
export const hasClaim = async (ctx: Pick<QueryCtx, "db">, scope: string, key: string): Promise<boolean> => {
    const existing = await findClaim(ctx, scope, key);

    return existing !== null && existing.expiresAt > Date.now();
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
 *
 * With a `claimedAt` (the one {@link claimFence} returned), only that claim is
 * deleted. Work that outlives its claim's TTL releases late, and by then a
 * redelivery may hold the key; that claim is not ours to clear.
 */
export const releaseClaim = async (ctx: ClaimCtx, scope: string, key: string, claimedAt?: number): Promise<void> => {
    const existing = await findClaim(ctx, scope, key);

    if (existing && (claimedAt === undefined || existing.claimedAt === claimedAt)) {
        await ctx.db.delete(existing._id);
    }
};

/**
 * The first string past every key that starts with `prefix`: the prefix with its last character advanced by one.
 * Correct under both byte-wise (SQLite) and code-unit ordering, which a sentinel suffix such as U+FFFF is not
 * for a key continuing with an astral character.
 */
const prefixEnd = (prefix: string): string => {
    const last = prefix.length - 1;

    return `${prefix.slice(0, last)}${String.fromCodePoint(prefix.codePointAt(last)! + 1)}`;
};

/** Rows deleted per {@link releaseClaimsWithPrefix} call. */
export const CLAIM_PREFIX_BATCH = 500;

/**
 * Deletes up to `limit` claims of `scope` whose key starts with `prefix` and says whether more may remain.
 * For a caller that scopes its keys by an owner (`<triggerId>:…`) and must clear them when the owner goes.
 */
export const releaseClaimsWithPrefix = async (ctx: ClaimCtx, scope: string, prefix: string, limit: number = CLAIM_PREFIX_BATCH): Promise<boolean> => {
    const rows = await ctx.db
        .query("idempotencyClaims")
        .withIndex("by_scope_key", (q) => q.eq("scope", scope).gte("key", prefix).lt("key", prefixEnd(prefix)))
        .take(limit);

    await Promise.all(rows.map(async (row) => await ctx.db.delete(row._id)));

    return rows.length >= limit;
};

/** {@link releaseClaimsWithPrefix} for what a deletion left past its first batch: one batch per call, rescheduling itself while batches come back full. */
export const purgeClaimsWithPrefix = internalMutation
    .input({ prefix: v.string().max(200), scope: v.string().max(200) })
    .output(v.null())
    .mutation(async ({ args: { prefix, scope }, ctx }) => {
        if (await releaseClaimsWithPrefix(ctx, scope, prefix)) {
            await ctx.scheduler.runAfter(0, internal.lib.claim_once.purgeClaimsWithPrefix, { prefix, scope });
        }

        return null;
    });

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

/** {@link claimKey} that answers with the claim's `claimedAt` (for {@link releaseKey}'s `claimedAt`), or `null` when the key is held. */
export const claimKeyFenced = internalMutation
    .input(vClaimArgs)
    .output(v.union(v.null(), v.number()))
    .mutation(async ({ args: { key, leaseMs, onLapse, scope, ttlMs, userId }, ctx }) => await claimFence(ctx, scope, key, { leaseMs, onLapse, ttlMs, userId }));

export const completeKey = internalMutation
    .input({ key: v.string(), scope: v.string() })
    .output(v.null())
    .mutation(async ({ args: { key, scope }, ctx }) => {
        await completeClaim(ctx, scope, key);

        return null;
    });

/** Attempts of {@link retryReleaseKey} before it gives up loudly. */
export const RELEASE_RETRY_MAX_ATTEMPTS = 6;

/** Delay before retry `attempt` (1-based) of a failed release: 5 s, then tripling. */
export const releaseRetryDelayMs = (attempt: number): number => 5000 * 3 ** (attempt - 1);

/**
 * A release that failed, tried again later. For a claim that outlasts any retry window
 * ({@link TRIGGER_DELIVERY_CLAIM_TTL_MS}) a lost release means the sender can never redeliver the work, so
 * the failure is rescheduled with backoff instead of logged. Idempotent: releasing a gone claim, or one
 * a newer holder replaced (`claimedAt`), deletes nothing. After {@link RELEASE_RETRY_MAX_ATTEMPTS} it throws,
 * so the job fails visibly.
 */
export const retryReleaseKey = internalMutation
    .input({ attempt: v.number(), claimedAt: v.optional(v.number()), key: v.string().max(1024), scope: v.string().max(200) })
    .output(v.null())
    .mutation(async ({ args: { attempt, claimedAt, key, scope }, ctx }) => {
        try {
            await releaseClaim(ctx, scope, key, claimedAt);
        } catch (error) {
            console.error(`[claim-once] Release of ${scope} claim failed (attempt ${String(attempt)} of ${String(RELEASE_RETRY_MAX_ATTEMPTS)}):`, error);

            if (attempt >= RELEASE_RETRY_MAX_ATTEMPTS) {
                throw error;
            }

            await ctx.scheduler.runAfter(releaseRetryDelayMs(attempt + 1), internal.lib.claim_once.retryReleaseKey, {
                attempt: attempt + 1,
                claimedAt,
                key,
                scope,
            });
        }

        return null;
    });

export const releaseKey = internalMutation
    .input({ claimedAt: v.optional(v.number()), key: v.string(), scope: v.string() })
    .output(v.null())
    .mutation(async ({ args: { claimedAt, key, scope }, ctx }) => {
        await releaseClaim(ctx, scope, key, claimedAt);

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
