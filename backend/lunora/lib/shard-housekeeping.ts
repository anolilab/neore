/**
 * Periodic work on every user's shard, driven from the root cron tick.
 *
 * The cron tick runs on `__root__`, but the tables its sweeps scan — expired
 * temporary chats and streams, stale presence, lapsed claims, due triggers and
 * tasks, GDPR request timeouts — now live on each user's own shard.
 * So the tick FANS OUT: a `.global()` census
 * (`shardActivity`) says which user shards exist and what they need, and the
 * tick schedules the work onto each of them (`shardKey`), where it runs against
 * that shard's rows exactly as it used to run against root's.
 *
 * - **Timed work** (schedule triggers, recurring tasks, stalled guest merges): each shard keeps
 *   `nextDueAt` in its census row. The one-minute tick dispatches
 *   {@link runShardTick} to every shard that is due; the tick recomputes the
 *   shard's next due time from its own tables.
 * - **Housekeeping** (the cleanup sweeps): every ten minutes the tick dispatches
 *   {@link runShardHousekeeping} to each shard active since its last sweep, and
 *   at least daily to any shard active in the last {@link HOUSEKEEPING_HORIZON_MS}
 *   — an expiry does not wait for its owner to come back.
 * - **Dormant shards** (idle past that horizon): only the `rateLimits` sweep.
 *   The census flag `rateLimitsPending` says a shard may hold rows: activity and
 *   any charge that adds a row set it, and the dormant sweep clears it when it
 *   leaves the table empty. A daily job reads only flagged dormant rows, through
 *   their index, and dispatches `sweepDormantShardRateLimits`
 *   (`lib/rate-limit-sweep.ts`) to each, so a shard that stays dormant and empty
 *   costs nothing.
 *
 * Each dispatch goes on the target user's own scheduler lane
 * (`shard-scheduler.ts`), so shards are swept side by side, not one at a time.
 */
import type { FunctionReference } from "lunorash/client";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { internalAction, internalMutation } from "../_generated/server";
import { enqueueJob } from "./job-queue";
import { cronsLogger } from "./logger";
import { patchRow } from "./patch";
import { currentUserShard } from "./shard-context";
import { runAfterOnShard } from "./shard-scheduler";
import { storedPage, storedRow } from "./stored-row";

/** How long a shard stays in the daily sweep after its last activity. */
export const HOUSEKEEPING_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
/** A swept shard with no new activity is swept again after this long. */
export const HOUSEKEEPING_IDLE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Activity is recorded at most this often per shard per isolate. */
const ACTIVITY_THROTTLE_MS = 10 * 60 * 1000;
/** A shard tick re-arms no sooner than this, so a stuck due row cannot spin. */
const MIN_TICK_INTERVAL_MS = 60 * 1000;

/** Shards dispatched per root run; the rest wait for the next one. */
export const DISPATCH_BATCH = 200;

/** An argument-less internal mutation, as in `crons.ts`. */
interface Sweep {
    name: string;
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the generated type of an argument-less mutation.
    ref: FunctionReference<"mutation", {}, unknown>;
}

/** Events-log prune batches one housekeeping run may delete (`pruneMcpEvents` deletes 200 per call). */
const MCP_EVENT_PRUNE_ROUNDS = 10;

/**
 * The sweeps a housekeeping run performs on one shard — the per-user half of
 * `crons.ts`. A function, so the references resolve at use, not at import.
 */
const shardSweeps = (): ReadonlyArray<Sweep> => [
    // Backstop for the minute tick: an event watcher whose shard lost its due row is still visited.
    { name: "dispatchDueEventTriggers", ref: internal.triggers.events.dispatchDueEventTriggers },
    // Same backstop for the watched repositories: a repository whose shard lost its due row is still polled.
    { name: "dispatchDueRepoPolls", ref: internal.source_control.freshness_internal.dispatchDueRepoPolls },
    // The stored state of linked pull requests that auto-archive reads (`source-control/pr-state.ts`); a no-op when the setting is off.
    { name: "dispatchLinkedPullRequestChecks", ref: internal.source_control.pr_state.dispatchLinkedPullRequestChecks },
    // Running pull request watches whose read is due (`source-control/pr-watch-poll.ts`); a no-op for a person with none.
    { name: "dispatchDueWatches", ref: internal.source_control.pr_watch_poll.dispatchDueWatches },
    { name: "cleanupExpiredPersistentStreams", ref: internal.chat.streaming.persistent.crons.cleanupExpiredStreams },
    { name: "purgeFinishedStreams", ref: internal.chat.streaming.persistent.purge.purgeFinishedStreams },
    { name: "failStaleMediaRows", ref: internal.chat.media_stale.failStaleMediaRows },
    { name: "reapStalledGoals", ref: internal.chat.goals.internal.reapStalledGoals },
    // A sub-agent waiting on an approval whose own reaper was lost (`sub-agents/functions.ts`).
    { name: "reapOverdueSubAgentWaits", ref: internal.sub_agents.functions.reapOverdueWaits },
    { name: "cleanupStaleWorkflowPresence", ref: internal.workflow.presence.cleanupStalePresence },
    { name: "reapLapsedClaims", ref: internal.lib.claim_once.reapLapsedClaims },
    { name: "purgeIdempotencyClaims", ref: internal.lib.claim_once.purgeExpiredClaims },
    // Events webhook subscriptions past their granted expiry (`public-api/event-webhooks.ts`). The Events log's retention is
    // drained in its own bounded loop (`pruneMcpEvents`), not here.
    { name: "reapExpiredEventSubscriptions", ref: internal.public_api.event_webhooks.reapExpiredEventSubscriptions },
    // Rate-limit rows charged on this shard, past every limit's window (`lib/rate-limit-sweep.ts`).
    { name: "sweepExpiredRateLimits", ref: internal.lib.rate_limit_sweep.sweepExpiredRateLimits },
    { name: "deleteExpiredTemporaryChats", ref: internal.crons.deleteExpiredTemporaryChats },
    // Per-user setting (`autoArchiveAfterDays`); does nothing for users who left it off.
    { name: "autoArchiveInactiveThreads", ref: internal.agent.auto_archive.autoArchiveInactiveThreads },
    { name: "cleanupExpiredExports", ref: internal.gdpr.request_sweeps.cleanupExpiredExports },
    { name: "handleGdprRequestTimeouts", ref: internal.gdpr.request_sweeps.handleGdprRequestTimeouts },
    { name: "pruneOldNotifications", ref: internal.notifications.functions.pruneOldNotifications },
    { name: "dispatchOutcomeEmails", ref: internal.notifications.task_email.dispatchOutcomeEmails },
    { name: "sweepDeviceCalls", ref: internal.devices.internal.sweepDeviceCalls },
    { name: "sweepKnowledgeFiles", ref: internal.knowledge.housekeeping.sweepKnowledgeFiles },
    { name: "pruneRetainedActivity", ref: internal.gdpr.retention.pruneRetainedActivity },
    // An export whose workflow died leaves its pieces and usage object on the shard; past their time to live, the sweep removes them.
    { name: "sweepUsageExportPieces", ref: internal.usage.gdpr.sweepUsageExportPieces },
    { name: "sweepUsageRollup", ref: internal.usage.backfill.sweepUsageRollup },
    { name: "sweepStagedChatUploads", ref: internal.file.sweepStagedChatUploads },
    { name: "pruneExpiredToolPermissionGrants", ref: internal.chat.tool_permissions.pruneExpiredToolPermissionGrants },
    // A run's saved prompt is cleared 28 days after the run settles (`triggers/functions.ts`); the run row stays.
    { name: "pruneExpiredRunPrompts", ref: internal.triggers.functions.pruneExpiredRunPrompts },
    // References the agent was never able to spend within their 24 hours (`chat/request-secret.ts`).
    { name: "sweepRequestedSecrets", ref: internal.chat.request_secret.sweepRequestedSecrets },
    // Guest links past their 24 hours, with what guests left on them (`chat/guest-links.ts`).
    { name: "sweepGuestLinks", ref: internal.chat.guest_links.sweepGuestLinks },
    { name: "backfillUnindexedFileLinks", ref: internal.agent.file_link_backfill.backfillUnindexedFileLinks },
    // Thread vectors written before they carried `archived` get it, once per shard (`agent/thread-vector-archived.ts`).
    { name: "sweepThreadVectorArchived", ref: internal.agent.thread_vector_archived.sweepThreadVectorArchived },
    // A bot whose delete failed after its tombstone was written is labelled live again (`bots/owner.ts`).
    { name: "restoreLiveBotOwners", ref: internal.bots.owner.restoreLiveBotOwners },
    // A guest merge whose queued job ran out of redeliveries is queued again from its saved progress (`lib/account-merge.ts`).
    { name: "resumeStalledGuestMerges", ref: internal.lib.account_merge.resumeStalledGuestMerges },
];

type CensusCtx = Pick<MutationCtx, "db">;

/** Pure: which census rows a housekeeping run sweeps now. Pinned by `shard-housekeeping.test.ts`. */
export const needsHousekeeping = (row: { housekeptAt?: number; lastActiveAt: number }, now: number): boolean => {
    if (now - row.lastActiveAt > HOUSEKEEPING_HORIZON_MS) {
        return false;
    }

    return row.housekeptAt === undefined || row.lastActiveAt >= row.housekeptAt || now - row.housekeptAt >= HOUSEKEEPING_IDLE_INTERVAL_MS;
};

/**
 * The census is a HINT for the root tick, written beside the caller's own work
 * (a sign-up, a trigger save) in D1 — not atomically with it. A failed hint must
 * never fail that work; the worst it costs is a late sweep.
 */
const bestEffort = async (what: string, write: () => Promise<void>): Promise<boolean> => {
    try {
        await write();

        return true;
    } catch (error) {
        cronsLogger.warn(`[housekeeping] ${what} failed:`, error);

        return false;
    }
};

/** `primary` for a read whose answer decides a flag write: a lagging replica could still show a flag the sweep cleared. */
const censusRow = async (ctx: CensusCtx, shardKey: string, consistency?: "primary") =>
    storedRow(await ctx.db.shardActivity.findFirst({ ...(consistency && { consistency }), where: { shardKey } }));

const touchedAt = new Map<string, number>();

/**
 * Record that `shardKey` (default: the shard this code serves) was active, so
 * housekeeping visits it. Throttled per isolate; a no-op off a user shard.
 */
export const noteShardActivity = async (ctx: CensusCtx, shardKey: string | undefined = currentUserShard(), now = Date.now()): Promise<void> => {
    if (shardKey === undefined || now - (touchedAt.get(shardKey) ?? 0) < ACTIVITY_THROTTLE_MS) {
        return;
    }

    touchedAt.set(shardKey, now);

    await bestEffort("noteShardActivity", async () => {
        const row = await censusRow(ctx, shardKey);

        if (row) {
            await ctx.db.patch("shardActivity", row._id, { lastActiveAt: now, rateLimitsPending: true });
        } else {
            await ctx.db.insert("shardActivity", { lastActiveAt: now, rateLimitsPending: true, shardKey });
        }
    });
};

/**
 * Tell the root tick that `shardKey` (default: this shard) has timed work due
 * at `dueAt`. Keeps the EARLIEST due time; {@link runShardTick} resets it.
 * `rearmPassed` (a guest merge's progress save): a due time already passed may
 * be in {@link dispatchDueShards}' hands, whose tick can run before this
 * caller's work is visible, so it is moved by a millisecond, still due, and
 * dispatch sees it changed and leaves it armed for the next one instead of
 * clearing it. Only that caller pays the write it takes;
 * any other keeps a passed time as it is. `consumed`: the passed due time the
 * shard tick read before its work; the tick has done that work (moved by the
 * dispatch or not), so `dueAt` replaces exactly that value instead of it staying
 * and waking the shard again for nothing. One moved since (a merge's save
 * during the tick, which the tick's merge check may have missed) is another
 * value, so it stays armed and the next dispatch sends the tick again.
 */
export const noteShardDue = async (
    ctx: CensusCtx,
    dueAt: number,
    shardKey: string | undefined = currentUserShard(),
    { consumed, rearmPassed = false }: { consumed?: number; rearmPassed?: boolean } = {},
): Promise<boolean> => {
    if (shardKey === undefined) {
        return true;
    }

    // Whether the wake was written: a caller that must not lose it (the retention prune) acts on a failure.
    return await bestEffort("noteShardDue", async () => {
        // From the primary: a stale row that still shows an earlier due time would skip the write, and the dispatch that cleared it would
        // then leave this shard with no wake.
        const row = await censusRow(ctx, shardKey, "primary");
        const now = Date.now();

        if (!row) {
            await ctx.db.insert("shardActivity", { lastActiveAt: now, nextDueAt: dueAt, shardKey });

            return;
        }

        if (row.nextDueAt === undefined || dueAt < row.nextDueAt || (consumed !== undefined && row.nextDueAt === consumed)) {
            await ctx.db.patch("shardActivity", row._id, { nextDueAt: dueAt });
        } else if (rearmPassed && row.nextDueAt <= now) {
            await ctx.db.patch("shardActivity", row._id, { nextDueAt: row.nextDueAt < now ? row.nextDueAt + 1 : row.nextDueAt - 1 });
        }
    });
};

/**
 * The census's retained-rows time when the shard holds none. A plain number, not an absent field: clearing a field means replacing the
 * whole census row from values read earlier, which can drop a wake written in between, while setting a number is a single field write.
 */
export const NO_RETENTION_DUE = Number.MAX_SAFE_INTEGER;

/**
 * Records when `shardKey`'s retained rows next expire (`gdpr/retention.ts`), or `NO_RETENTION_DUE` for none (`undefined` means the same).
 * The tick prunes only once this has come, so a tick for other work reads just this row. A write that fails leaves the old time: the tick
 * then prunes early, which is harmless.
 */
export const setRetentionDue = async (ctx: CensusCtx, dueAt: number | undefined, shardKey: string | undefined = currentUserShard()): Promise<boolean> => {
    if (shardKey === undefined) {
        return true;
    }

    const next = dueAt ?? NO_RETENTION_DUE;

    // Whether the time was written: the prune acts on a failure, so the tick re-arms the shard.
    return await bestEffort("setRetentionDue", async () => {
        const row = await censusRow(ctx, shardKey, "primary");

        if (!row) {
            if (next !== NO_RETENTION_DUE) {
                await ctx.db.insert("shardActivity", { lastActiveAt: Date.now(), retentionDueAt: next, shardKey });
            }

            return;
        }

        // Clearing never drops a later time: a prune that found no rows in its snapshot must not clear a time a reply has since brought
        // forward, which is still ahead. A time already past is the one this prune served, so it is cleared.
        const stored = row.retentionDueAt;

        if (next === NO_RETENTION_DUE && stored !== undefined && stored !== NO_RETENTION_DUE && stored > Date.now()) {
            return;
        }

        await ctx.db.patch("shardActivity", row._id, { retentionDueAt: next });
    });
};

/**
 * Brings `shardKey`'s retained-rows time forward to `dueAt` if it is later (or unset): a new row expires long after the rows already
 * there, so it must not push the time back. The prune sets the exact time (`setRetentionDue`).
 */
export const noteRetentionDueAt = async (ctx: CensusCtx, dueAt: number, shardKey: string | undefined = currentUserShard()): Promise<void> => {
    if (shardKey === undefined) {
        return;
    }

    await bestEffort("noteRetentionDueAt", async () => {
        const row = await censusRow(ctx, shardKey, "primary");

        if (!row) {
            await ctx.db.insert("shardActivity", { lastActiveAt: Date.now(), retentionDueAt: dueAt, shardKey });

            return;
        }

        if (row.retentionDueAt === undefined || dueAt < row.retentionDueAt) {
            await ctx.db.patch("shardActivity", row._id, { retentionDueAt: dueAt });
        }
    });
};

/**
 * A reply's retained rows, expiring at `dueAt`: brings the shard's wake and its retained-rows time forward to it, if either is later (or
 * unset). One census read covers both, where two calls read it twice.
 */
export const noteRetentionWake = async (ctx: CensusCtx, dueAt: number, shardKey: string | undefined = currentUserShard()): Promise<boolean> => {
    if (shardKey === undefined) {
        return true;
    }

    // Whether the wake was written: a caller that must not lose it (the Events log's retry) acts on a failure.
    return await bestEffort("noteRetentionWake", async () => {
        const row = await censusRow(ctx, shardKey, "primary");

        if (!row) {
            await ctx.db.insert("shardActivity", { lastActiveAt: Date.now(), nextDueAt: dueAt, retentionDueAt: dueAt, shardKey });

            return;
        }

        const wake = row.nextDueAt === undefined || dueAt < row.nextDueAt;
        const retention = row.retentionDueAt === undefined || dueAt < row.retentionDueAt;

        if (wake || retention) {
            await ctx.db.patch("shardActivity", row._id, {
                ...(wake && { nextDueAt: dueAt }),
                ...(retention && { retentionDueAt: dueAt }),
            });
        }
    });
};

/** Before the retry of a failed {@link noteRateLimitsPending} write, so a passing D1 failure has cleared. */
export const RATE_LIMITS_PENDING_RETRY_MS = 30 * 1000;

const markRateLimitsPendingRow = async (ctx: CensusCtx, shardKey: string): Promise<void> => {
    const row = await censusRow(ctx, shardKey, "primary");

    if (!row) {
        await ctx.db.insert("shardActivity", { lastActiveAt: Date.now(), rateLimitsPending: true, shardKey });
    } else if (row.rateLimitsPending !== true) {
        await ctx.db.patch("shardActivity", row._id, { rateLimitsPending: true });
    }
};

/**
 * On a user shard: a charge added a `rateLimits` row, so the dormant-shard dispatch must visit this shard. A charge need
 * not move `lastActiveAt` (a guest's post on the owner's shard), so this is its own note. Writes only when the flag is
 * off; a charge that only updates a row needs none, since a table holding a row keeps the flag on
 * ({@link settleRateLimitsPending} re-checks after clearing).
 *
 * The row is already written, and a later charge on that key only updates it, so a failed write would leave the flag off
 * for good: it is retried out of band, by {@link markRateLimitsPending} on this shard through the jobs queue (whose own
 * redelivery bounds it to three tries). Neither the write nor the send ever fails the charge.
 */
export const noteRateLimitsPending = async (ctx: CensusCtx, shardKey: string | undefined = currentUserShard()): Promise<void> => {
    if (shardKey === undefined) {
        return;
    }

    if (await bestEffort("noteRateLimitsPending", async () => await markRateLimitsPendingRow(ctx, shardKey))) {
        return;
    }

    await bestEffort("noteRateLimitsPending retry", async () => {
        await enqueueJob(internal.lib.shard_housekeeping.markRateLimitsPending, { shardKey }, { delayMs: RATE_LIMITS_PENDING_RETRY_MS, shardKey });
    });
};

/** The retry of a failed {@link noteRateLimitsPending} write. It throws on failure, so the queue delivers it again. */
export const markRateLimitsPending = internalMutation
    .input({ shardKey: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await markRateLimitsPendingRow(ctx, args.shardKey);

        return null;
    });

/**
 * On a user shard, from the dormant sweep: set the flag to whether the `rateLimits` table still holds a row. Clearing
 * writes first and reads again after, so a charge racing the sweep is never lost: a row added before the second read
 * is seen there and sets the flag back, and a charge after it finds the flag off and sets it itself
 * ({@link noteRateLimitsPending}, which runs after its row is written). Returns whether the flag is now off.
 */
export const settleRateLimitsPending = async (ctx: Pick<MutationCtx, "db">, shardKey: string | undefined = currentUserShard()): Promise<boolean> => {
    if (shardKey === undefined || (await ctx.db.query("rateLimits").first()) !== null) {
        return false;
    }

    let cleared = false;

    const settled = await bestEffort("settleRateLimitsPending", async () => {
        const row = await censusRow(ctx, shardKey, "primary");

        if (!row) {
            return;
        }

        await ctx.db.patch("shardActivity", row._id, { rateLimitsPending: false });

        if ((await ctx.db.query("rateLimits").first()) === null) {
            cleared = true;
        } else {
            await ctx.db.patch("shardActivity", row._id, { rateLimitsPending: true });
        }
    });

    // A census write failed partway: the flag may now be off while a racing charge left a row. Put it back out of band,
    // as a failed charge note does, so the dormant dispatch still finds this shard.
    if (!settled && (await ctx.db.query("rateLimits").first()) !== null) {
        await bestEffort("settleRateLimitsPending retry", async () => {
            await enqueueJob(internal.lib.shard_housekeeping.markRateLimitsPending, { shardKey }, { delayMs: RATE_LIMITS_PENDING_RETRY_MS, shardKey });
        });
    }

    return cleared;
};

/** `noteShardActivity` for callers outside a shard (the HTTP layer), run on the user's shard. */
export const recordShardActivity = internalMutation
    .input({ shardKey: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await noteShardActivity(ctx, args.shardKey);

        return null;
    });

/** Root, every minute: send {@link runShardTick} to each shard whose timed work is due. */
export const dispatchDueShards = internalMutation
    .input({})
    .output(v.object({ dispatched: v.number() }))
    .mutation(async ({ ctx }) => {
        const { now } = ctx;
        const { page: due } = await ctx.db.shardActivity.findMany({
            limit: DISPATCH_BATCH,
            orderBy: [{ nextDueAt: "asc" }],
            where: { nextDueAt: { lte: now } },
        });

        let dispatched = 0;

        for (const row of due) {
            // Read again, primary, right before the clear: only the due time this dispatch read is consumed. One written since
            // (`noteShardDue` moves a passed one) stays armed, so its work is dispatched again, never lost to this clear.
            const fresh = await censusRow(ctx, row.shardKey, "primary");

            if (fresh?.nextDueAt === undefined || fresh.nextDueAt > now) {
                // Dispatched, or re-armed by a tick, since this read: nothing is due here any more.
                continue;
            }

            const cleared = fresh.nextDueAt === row.nextDueAt;

            if (cleared) {
                // Cleared before the tick is sent, re-armed by the shard tick — so a slow tick is not dispatched twice, and work
                // noted after this clear arms a due time of its own.
                await patchRow(ctx.db, "shardActivity", fresh, { nextDueAt: undefined });
            }

            try {
                await runAfterOnShard(ctx.scheduler, 0, internal.lib.shard_housekeeping.runShardTick, {}, row.shardKey);
            } catch (error) {
                // The send failed: the due time this dispatch cleared is put back, and nothing is thrown, so that write
                // commits (a throw would roll it back with the clear) and the next dispatch sends the tick again. The
                // shards after this one are still dispatched.
                if (cleared) {
                    await patchRow(ctx.db, "shardActivity", fresh, { nextDueAt: fresh.nextDueAt });
                }

                cronsLogger.error(`[housekeeping] the tick of shard ${row.shardKey} was not sent; it stays due:`, error);

                continue;
            }

            dispatched += 1;
        }

        return { dispatched };
    });

/** Root, every ten minutes: send {@link runShardHousekeeping} to each shard that needs it. */
export const dispatchShardHousekeeping = internalMutation
    .input({})
    .output(v.object({ dispatched: v.number() }))
    .mutation(async ({ ctx }) => {
        const { now } = ctx;
        const { page: recent } = storedPage(
            await ctx.db.shardActivity.findMany({
                limit: DISPATCH_BATCH * 5,
                orderBy: [{ lastActiveAt: "desc" }],
                where: { lastActiveAt: { gte: now - HOUSEKEEPING_HORIZON_MS } },
            }),
        );
        const due = recent.filter((row) => needsHousekeeping(row, now)).slice(0, DISPATCH_BATCH);

        for (const row of due) {
            await runAfterOnShard(ctx.scheduler, 0, internal.lib.shard_housekeeping.runShardHousekeeping, {}, row.shardKey);
            await ctx.db.patch("shardActivity", row._id, { housekeptAt: now });
        }

        return { dispatched: due.length };
    });

/**
 * Root, daily: send `sweepDormantShardRateLimits` (`lib/rate-limit-sweep.ts`) to each flagged shard idle past
 * {@link HOUSEKEEPING_HORIZON_MS}, which {@link dispatchShardHousekeeping} no longer visits. It reads only flagged rows,
 * through `by_rateLimitsPending_lastActiveAt`, a page per run; a full page schedules the next one after the last row's
 * (`lastActiveAt`, `_id`). That key is unique and stable, so a shard turning active between pages (it leaves the range)
 * or a tie on `lastActiveAt` cannot make the next page skip one. `before` is fixed by the first run, so the chain pages
 * one range, which never overlaps the housekeeping range (`lastActiveAt >= now - horizon`). A shard crossing the horizon
 * on the day may meet both; the sweep only deletes rows past every window, so a second run is a no-op.
 */
export const dispatchDormantRateLimitSweeps = internalMutation
    .input({
        after: v.optional(v.object({ id: v.id("shardActivity"), lastActiveAt: v.number() })),
        before: v.optional(v.number()),
    })
    .output(v.object({ dispatched: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const before = args.before ?? ctx.now - HOUSEKEEPING_HORIZON_MS;
        const { after } = args;
        const { page } = await ctx.db.shardActivity.findMany({
            limit: DISPATCH_BATCH,
            orderBy: [{ lastActiveAt: "asc" }, { _id: "asc" }],
            where: {
                lastActiveAt: { lt: before },
                rateLimitsPending: true,
                ...(after && { OR: [{ lastActiveAt: { gt: after.lastActiveAt } }, { _id: { gt: after.id }, lastActiveAt: after.lastActiveAt }] }),
            },
        });

        for (const row of page) {
            await runAfterOnShard(ctx.scheduler, 0, internal.lib.rate_limit_sweep.sweepDormantShardRateLimits, {}, row.shardKey);
        }

        const last = page.at(-1);

        if (page.length === DISPATCH_BATCH && last) {
            await ctx.scheduler.runAfter(0, internal.lib.shard_housekeeping.dispatchDormantRateLimitSweeps, {
                after: { id: last._id, lastActiveAt: last.lastActiveAt },
                before,
            });
        }

        return { dispatched: page.length };
    });

/**
 * On a user shard: fire due schedule triggers and recurring tasks, then re-arm
 * the census with this shard's next due time.
 */
export const runShardTick = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        // Also schedules `checkDueTasks` (see `triggers/schedule.ts`).
        // A failure here must not stop the retention prune or the re-arming below: the shard is then armed for now, as a reap that failed is.
        const triggersChecked = await bestEffort("checkDueTriggers", async () => {
            await ctx.runMutation(internal.triggers.schedule.checkDueTriggers, {});
        });

        // The export runs due on this shard (`usage/gdpr.ts`): the tick reaches an idle shard, so its runs are not left to the daily sweep.
        await bestEffort("sweepUsageExportPieces", async () => {
            await ctx.runMutation(internal.usage.gdpr.sweepUsageExportPieces, {});
        });
        // The retained rows past their window (`gdpr/retention.ts`): a dormant shard gets no housekeeping visit, so its rows expire here, when
        // the census wakes it for them. Pruned only once the census says they have expired, so a tick for other work reads just that row. A
        // census read that fails prunes now, which is harmless.
        const shardKey = currentUserShard();
        // The shard's retained rows' time, read here; a read that fails is taken as due, so the rows are not left for it.
        const retention = await (async () => {
            try {
                const census = shardKey === undefined ? undefined : await censusRow(ctx, shardKey, "primary");

                return { at: census?.retentionDueAt, due: census?.nextDueAt, failed: false };
            } catch {
                return { at: undefined, due: undefined, failed: true };
            }
        })();
        // A passed due time read here, before the work below: the one this tick serves, so the re-arm replaces it. A read that failed
        // names none, and a passed time is then left to wake the shard once more.
        const consumedDue = retention.due !== undefined && retention.due <= ctx.now ? retention.due : undefined;
        const retentionDue = retention.failed || (retention.at !== undefined && retention.at !== NO_RETENTION_DUE && retention.at <= ctx.now);
        // Not yet due: the time is a wake of its own, so the shard is not left with none once this tick's other work is done.
        const retentionLater = !retentionDue && retention.at !== undefined && retention.at !== NO_RETENTION_DUE ? retention.at : undefined;

        // The Events log's expired rows (`public-api/events.ts`), pruned before the retention sweep sets the shard's time, so that time
        // counts only what is left. A dormant shard gets no housekeeping visit, so its expired events expire here, with its other rows.
        // One batch in this transaction: a nested mutation shares the tick's read budget, so the rows left are a tick of their own, scheduled
        // below in a transaction of its own (`eventsLeft`), not looped here.
        let eventsLeft = false;

        if (retentionDue) {
            await bestEffort("pruneMcpEvents", async () => {
                const { hasMore } = await ctx.runMutation(internal.public_api.events.pruneMcpEvents, {});

                eventsLeft = hasMore;
            });
        }

        if (eventsLeft && shardKey !== undefined) {
            await bestEffort("pruneMcpEventsNext", async () => {
                await runAfterOnShard(ctx.scheduler, 0, internal.public_api.events.pruneMcpEventsBacklog, {}, shardKey);
            });
        }

        const pruned = retentionDue
            ? await bestEffort("pruneRetainedActivity", async () => {
                  await ctx.runMutation(internal.gdpr.retention.pruneRetainedActivity, {});
              })
            : true;

        // Event watchers whose next check is due; their checks run as actions. A failure here must not stop the reaping
        // and the re-arming below, or the shard's other schedules stall with it.
        await bestEffort("dispatchDueEventTriggers", async () => {
            await ctx.runMutation(internal.triggers.events.dispatchDueEventTriggers, {});
        });
        // Watched repositories whose poll is due (Develop); a failure here must not stall the re-arming below either.
        await bestEffort("dispatchDueRepoPolls", async () => {
            await ctx.runMutation(internal.source_control.freshness_internal.dispatchDueRepoPolls, {});
        });
        // Coding-agent turns that went silent; re-arms this shard for the next one to expire.
        const reaped = await bestEffort("reapHostStreams", async () => {
            await ctx.runMutation(internal.acp.ingest.reapHostStreams, {});
        });

        // Guest merges into this shard's account that no job carries on (`lib/account-merge.ts`): each save of a merge's progress arms
        // this tick, so a stalled merge is reached however many more active shards the housekeeping dispatch reads first.
        let mergeCheckAt: number | undefined;
        const mergesChecked = await bestEffort("resumeStalledGuestMergesOnTick", async () => {
            ({ nextCheckAt: mergeCheckAt } = await ctx.runMutation(internal.lib.account_merge.resumeStalledGuestMergesOnTick, {}));
        });

        const { now } = ctx;
        // The earliest export run due here. A read that fails must not stop the re-arming below: the shard is then armed for now, as
        // a reap that failed is.
        const exportRunRead = await (async () => {
            try {
                const { page } = await ctx.db.usageExportRuns.findMany({ consistency: "primary", limit: 1, orderBy: [{ deleteAt: "asc" }] });

                return { deleteAt: page[0]?.deleteAt };
            } catch (error) {
                cronsLogger.warn("[housekeeping] the export run read failed:", error);

                return undefined;
            }
        })();
        const [trigger, task, repoPoll] = await Promise.all([
            // Only triggers with a next run armed: a schedule's first run or an event watcher's next check.
            // A webhook trigger has no `nextTriggerAt`, and `.first()` on the enabled prefix could return
            // one, which then armed the shard to tick every minute for nothing.
            ctx.db
                .query("triggers")
                .withIndex("by_enabled_nextTriggerAt", (q) => q.eq("enabled", true).gt("nextTriggerAt", 0))
                .first(),
            ctx.db
                .query("tasks")
                .withIndex("by_recurring_and_nextRunAt", (q) => q.eq("recurring", true))
                .first(),
            // The earliest armed poll of a watched repository (Develop): `gt(0)` leaves out a row nothing armed.
            ctx.db
                .query("watchedRepositories")
                .withIndex("by_nextPollAt", (q) => q.gt("nextPollAt", 0))
                .first(),
        ]);
        // The earliest stuck check of a blocked or failed task (`tasks/AGENTS.md`). Without it, a tick that re-arms the shard
        // drops the wake-up a stuck transition set, and the notice waits for the daily housekeeping instead.
        const stuckChecks = await Promise.all(
            (["blocked", "failed"] as const).map((status) =>
                ctx.db
                    .query("tasks")
                    .withIndex("by_status_and_stuckCheckAt", (q) => q.eq("status", status).gt("stuckCheckAt", 0))
                    .first(),
            ),
        );
        const candidates = [
            trigger?.nextTriggerAt,
            task?.nextRunAt,
            repoPoll?.nextPollAt,
            exportRunRead?.deleteAt,
            mergeCheckAt,
            retentionLater,
            ...stuckChecks.map((row) => row?.stuckCheckAt),
        ].filter((at): at is number => at !== undefined);

        // The dispatch cleared this shard's due time; a reap, a merge check, a retention prune or an export-run read that failed recorded
        // no next time, so try again. So does an Events backlog the rounds above did not finish.
        if (!reaped || !mergesChecked || !pruned || !triggersChecked || exportRunRead === undefined || eventsLeft) {
            candidates.push(now);
        }

        if (candidates.length > 0) {
            // A passed due time left armed (a save moved it while the dispatch read it) is this tick's to replace.
            await noteShardDue(ctx, Math.max(Math.min(...candidates), now + MIN_TICK_INTERVAL_MS), undefined, {
                ...(consumedDue !== undefined && { consumed: consumedDue }),
            });
        }

        return null;
    });

/** On a user shard: every cleanup sweep, one after another; a failure is logged and the rest still run. */
export const runShardHousekeeping = internalAction
    .input({})
    .output(v.object({ failed: v.array(v.string()) }))
    .action(async ({ ctx }) => {
        const failed: string[] = [];

        for (const sweep of shardSweeps()) {
            try {
                await ctx.runMutation(sweep.ref, {});
            } catch (error) {
                failed.push(sweep.name);
                cronsLogger.error(`[housekeeping] ${sweep.name} failed:`, error);
            }
        }

        // The Events log's seven-day window (`public-api/events.ts`): one batch per call, so a backlog takes several calls, up to a
        // bounded number per run. The rest waits for the next run.
        for (let round = 0; round < MCP_EVENT_PRUNE_ROUNDS; round += 1) {
            const pruned = await ctx.runMutation(internal.public_api.events.pruneMcpEvents, {}).catch((error: unknown) => {
                failed.push("pruneMcpEvents");
                cronsLogger.error("[housekeeping] pruneMcpEvents failed:", error);

                return { hasMore: false };
            });

            if (!pruned.hasMore) {
                break;
            }
        }

        // Stale task rounds (`checkDueTasks`), which the minute tick only visits on due shards.
        await ctx.runMutation(internal.tasks.internal.checkDueTasks, {}).catch((error: unknown) => {
            failed.push("checkDueTasks");
            cronsLogger.error("[housekeeping] checkDueTasks failed:", error);
        });

        return { failed };
    });
