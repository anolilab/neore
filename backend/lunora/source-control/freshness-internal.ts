/**
 * Develop's freshness, the part that runs on the user's shard: which watched repositories are due, what a poll
 * left behind, and what a webhook may change (a dirty mark, nothing else).
 *
 * The shape is the event trigger's: {@link dispatchDueRepoPolls} (called by the shard tick and, as a backstop, by
 * the housekeeping sweep) leases each due repository in the same transaction and schedules its poll action;
 * {@link recordRepoPoll} applies the answer only while that lease still holds. A repository the user stopped
 * watching has no row, so nothing is dispatched for it and a poll already in flight records nothing.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { claimOnce, TRIGGER_CLAIM_TTL_MS } from "../lib/claim-once";
import { noteShardDue } from "../lib/shard-housekeeping";
import { MAX_LENGTH } from "../lib/validators";
import { notifyQuietly } from "../notifications/notify";
import { cachedRequestsOf, enteredRequests, nextPollDelay, POLL_LEASE_MS, REFRESH_MIN_AGE_MS, requestDedupeKey } from "./freshness-logic";
import type { ReadFailure } from "./read-host";
import { vCachedRequest } from "./validators";

/** Claim scope of a repository webhook delivery: keyed on the signature, since nothing else on it is signed. */
export const WATCH_WEBHOOK_SCOPE = "watch-webhook";

const DISPATCH_BATCH = 25;

/** What a poll found: nothing new, a new list, or a failure (which leaves the cached list as it was). */
const vRecorded = v.union(
    v.object({ kind: v.literal("not_modified") }),
    v.object({
        etag: v.union(v.string().max(MAX_LENGTH.short), v.null()),
        kind: v.literal("changed"),
        login: v.string().max(MAX_LENGTH.short),
        requested: v.array(vCachedRequest),
    }),
    v.object({
        kind: v.literal("failed"),
        status: v.union(
            v.literal("forbidden"),
            v.literal("host_error"),
            v.literal("needs_reconnect"),
            v.literal("not_connected"),
            v.literal("not_found"),
            v.literal("rate_limited"),
        ),
    }),
);

/** A poll lease is live while it has not run out: a lapsed one means the poll died and the repository is polled again. */
const isLeased = (row: Pick<Doc<"watchedRepositories">, "leasedAt">, now: number): boolean => row.leasedAt > 0 && now < row.leasedAt + POLL_LEASE_MS;

/** Takes the repository for one poll: moves its next poll out by the lease, so a second tick finds it not due. */
const takeLease = async (ctx: Pick<MutationCtx, "db" | "scheduler">, row: Doc<"watchedRepositories">, now: number): Promise<boolean> => {
    try {
        await ctx.scheduler.runAfter(0, internal.source_control.freshness_poll.pollWatchedRepo, { lease: now, watchId: row._id });
    } catch (error) {
        console.error(`[Develop] Could not schedule the poll of ${row.repository}; it stays due for the next tick`, error);

        return false;
    }

    await ctx.db.patch(row._id, { leasedAt: now, nextPollAt: now + POLL_LEASE_MS });

    return true;
};

/**
 * On a user shard: starts the poll of every watched repository that is due. The lease is taken here, in the same
 * transaction, so the minute tick and the housekeeping sweep running side by side dispatch nothing twice.
 */
export const dispatchDueRepoPolls = internalMutation
    .input({})
    .output(v.object({ dispatched: v.number() }))
    .mutation(async ({ ctx }) => {
        const { now } = ctx;
        // `gt(0)` leaves out a row nothing armed; one more than a batch says whether a batch is left over.
        const due = await ctx.db
            .query("watchedRepositories")
            .withIndex("by_nextPollAt", (q) => q.gt("nextPollAt", 0).lte("nextPollAt", now))
            .take(DISPATCH_BATCH + 1);
        let dispatched = 0;

        for (const row of due.slice(0, DISPATCH_BATCH)) {
            if (await takeLease(ctx, row, now)) {
                dispatched += 1;
            }
        }

        // The lease may lapse with nobody listening (a poll that dies, a sweep that ran instead of the tick): wake the shard then.
        if (dispatched > 0) {
            await noteShardDue(ctx, now + POLL_LEASE_MS, due[0]!.userId);
        }

        if (due.length > DISPATCH_BATCH) {
            await noteShardDue(ctx, now, due[0]!.userId);
        }

        return { dispatched };
    });

/**
 * "Refresh on open": leases the caller's repositories that were not checked in the last few seconds and are not
 * being polled, for the action to poll now. A repository with a live lease is somebody else's poll.
 */
export const leaseWatchedRepositoriesForRefresh = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.array(v.object({ lease: v.number(), watchId: v.id("watchedRepositories") })))
    .mutation(async ({ args, ctx }) => {
        const { now } = ctx;
        const rows = await ctx.db
            .query("watchedRepositories")
            .withIndex("by_user_and_repository", (q) => q.eq("userId", args.userId))
            .take(100);
        const leased: { lease: number; watchId: Doc<"watchedRepositories">["_id"] }[] = [];

        for (const row of rows) {
            if (isLeased(row, now) || (row.dirtyAt === 0 && now - row.checkedAt < REFRESH_MIN_AGE_MS)) {
                continue;
            }

            await ctx.db.patch(row._id, { leasedAt: now, nextPollAt: now + POLL_LEASE_MS });
            leased.push({ lease: now, watchId: row._id });
        }

        if (leased.length > 0) {
            await noteShardDue(ctx, now + POLL_LEASE_MS, args.userId);
        }

        return leased;
    });

export const getWatchForPoll = internalQuery
    .input({ watchId: v.id("watchedRepositories") })
    .output(
        v.union(
            v.null(),
            v.object({
                etag: v.union(v.string(), v.null()),
                leasedAt: v.number(),
                login: v.union(v.string(), v.null()),
                repository: v.string(),
                userId: v.string(),
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        const row = await ctx.db.get(args.watchId);

        return row === null ? null : { etag: row.etag, leasedAt: row.leasedAt, login: row.login, repository: row.repository, userId: row.userId };
    });

/**
 * Applies one poll's answer. Dropped (nothing written, nobody notified, nothing re-armed) when the repository is no
 * longer watched or the lease is not the poll's own: a poll that outlived an unwatch, a redelivery, a poll that
 * finished after its lease ran out and a newer one took over.
 *
 * The first successful poll is the baseline: it stores the list and tells nobody, so watching a repository with
 * five open requests does not open with five notifications. After that, a request that was not in the list is new
 * and notifies once (`requestDedupeKey`), in the same transaction that stores the list.
 */
export const recordRepoPoll = internalMutation
    .input({ lease: v.number(), outcome: vRecorded, watchId: v.id("watchedRepositories") })
    .output(v.object({ applied: v.boolean(), notified: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const row = await ctx.db.get(args.watchId);

        if (row === null || row.leasedAt !== args.lease) {
            return { applied: false, notified: 0 };
        }

        const { now } = ctx;
        const status: "ok" | ReadFailure = args.outcome.kind === "failed" ? args.outcome.status : "ok";
        // A webhook that arrived during the poll may describe a change the answer predates: look again at once.
        const changedMeanwhile = row.dirtyAt > args.lease;
        const delay = changedMeanwhile ? 0 : nextPollDelay(status, { now, webhookSeenAt: row.webhookSeenAt });
        const nextPollAt = now + delay;
        const common = { checkedAt: now, dirtyAt: changedMeanwhile ? row.dirtyAt : 0, lastStatus: status, leasedAt: 0, nextPollAt };
        let notified = 0;

        if (args.outcome.kind === "changed") {
            const requested = cachedRequestsOf(args.outcome.requested);

            if (row.seeded) {
                for (const entered of enteredRequests(row.requested, requested)) {
                    const id = await notifyQuietly(ctx, {
                        body: `${row.repository}#${String(entered.number)} · ${entered.authorLogin}`,
                        dedupeKey: requestDedupeKey(row.hostOrigin, row.repository, entered),
                        link: `/develop?repository=${encodeURIComponent(row.repository)}&number=${String(entered.number)}`,
                        title: entered.title,
                        type: "review_request",
                        userId: row.userId,
                    });

                    notified += id === null ? 0 : 1;
                }
            }

            await ctx.db.patch(row._id, { ...common, etag: args.outcome.etag, login: args.outcome.login, requested, seeded: true });
        } else {
            await ctx.db.patch(row._id, common);
        }

        await noteShardDue(ctx, nextPollAt, row.userId);

        return { applied: true, notified };
    });

export const getWatchForWebhook = internalQuery
    .input({ watchId: v.id("watchedRepositories") })
    .output(v.union(v.null(), v.object({ webhookSecret: v.string() })))
    .query(async ({ args, ctx }) => {
        const row = await ctx.db.get(args.watchId);

        return row?.webhookSecret === undefined ? null : { webhookSecret: row.webhookSecret };
    });

/**
 * A verified delivery. It claims its signature once, and the ONLY thing it does is mark the repository dirty so the
 * next tick polls it: no field of the delivery is read here or anywhere (the handler never parses the body), so
 * nothing a sender can type reaches the cache, a notification or a host call. What changed is read from the host.
 */
export const acceptWatchDelivery = internalMutation
    .input({ signature: v.string().max(MAX_LENGTH.short), watchId: v.id("watchedRepositories") })
    .output(v.union(v.literal("accepted"), v.literal("duplicate"), v.literal("not_found")))
    .mutation(async ({ args, ctx }) => {
        const row = await ctx.db.get(args.watchId);

        if (row?.webhookSecret === undefined) {
            return "not_found" as const;
        }

        if (!(await claimOnce(ctx, WATCH_WEBHOOK_SCOPE, `${args.watchId}:${args.signature}`, TRIGGER_CLAIM_TTL_MS, row.userId))) {
            return "duplicate" as const;
        }

        const { now } = ctx;

        // A poll in flight keeps its lease; `recordRepoPoll` sees the mark newer than the lease and looks again.
        await ctx.db.patch(row._id, { dirtyAt: now, webhookSeenAt: now, ...(!isLeased(row, now) && { nextPollAt: now }) });
        await noteShardDue(ctx, now, row.userId);

        return "accepted" as const;
    });
