/**
 * The poller of pull request watches (`pr-watch.ts` starts one, `pr-watch-logic.ts` decides what a read means). A shard
 * sweep leases the running watches whose last read is old enough (stamping `watchCheckedAt` in the same transaction, so
 * the next sweep skips them) and schedules one action per link. The action reads the pull request with the person's
 * token and hands the observation to a mutation, which decides against the watch as it is stored now and records the
 * result only while its lease is still the link's current one and the same watch is still running. A late answer, or one
 * for a watch that was stopped or restarted meanwhile, is dropped.
 *
 * A failed read changes nothing: the lease stamp alone makes the next try wait for the interval.
 * This file records a wake (`lastWakeAt`, the count and the owed reasons in `watchPending`) and sends nothing: the
 * delivery clears `watchPending` once it has happened.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { resolveGithubToken } from "../connectors/lib/github-token";
import { currentUserShard } from "../lib/shard-context";
import { rollupOf } from "./checks-logic";
import { DEVELOP_DRIVER } from "./develop-driver";
import { signedInLogin } from "./drivers/github";
import type { PullRequestObservation } from "./pr-watch-logic";
import { decideWatch, stateOf, storedWatchOf } from "./pr-watch-logic";
import { readFromHost } from "./read-host";
import type { CheckRun, CheckState, CheckSummary, MergeState } from "./types";

/** A running watch is read again once its last read is this old. */
export const PR_WATCH_POLL_INTERVAL_MS = 3 * 60 * 1000;
/** Watches one sweep leases, so one person's host calls stay bounded whatever the person's limit is. */
const POLL_LIMIT = 10;
/** Failing check names kept in an observation, and their length: the names are text the host sent. */
const MAX_FAILING_NAMES = 10;
const MAX_NAME_LENGTH = 200;
/** Reviews kept in an observation: the newest ones, as the host lists them. */
const MAX_REVIEWS = 100;

const NOT_PASSING = new Set<CheckState>(["cancelled", "failure"]);

const vObservation = v.object({
    checks: v.union(v.literal("failing"), v.literal("passing"), v.literal("pending")),
    failingCheckNames: v.array(v.string()),
    headSha: v.string(),
    mergeable: v.union(v.literal("clean"), v.literal("conflicting"), v.literal("unknown")),
    reviews: v.array(v.object({ authorLogin: v.string(), id: v.string() })),
    state: v.union(v.literal("closed"), v.literal("merged"), v.literal("open")),
    watcherLogin: v.string(),
});

/**
 * What the head's checks add up to for a watch, by the same rollup the status chip reads (`checks-logic.ts`): "failing" while a
 * required (or unknown) check failed, "pending" while one is running or a required check has not reported yet (or the host
 * holds more checks than were listed), "passing" only when every required check reported and passed. A check the rules do not
 * require never counts.
 */
export const checksOf = (summary: CheckSummary): { failing: CheckRun[]; status: PullRequestObservation["checks"] } => {
    const failing = summary.checks.filter((check) => NOT_PASSING.has(check.state) && check.required !== false);
    const rollup = rollupOf(summary.checks, summary.total, summary.required);

    if (rollup.state === "failing") {
        return { failing, status: "failing" };
    }

    const settled = rollup.state === "none" || rollup.state === "passing";

    return { failing, status: settled && rollup.complete ? "passing" : "pending" };
};

const mergeableOf = (state: MergeState | undefined): PullRequestObservation["mergeable"] => {
    if (state === undefined || state === "unknown") {
        return "unknown";
    }

    return state === "conflicting" ? "conflicting" : "clean";
};

/** Shard sweep: leases the running watches that are due, oldest read first, and schedules one host read for each. */
export const dispatchDueWatches = internalMutation
    .input({})
    .output(v.object({ dispatched: v.number() }))
    .mutation(async ({ ctx }) => {
        const userId = currentUserShard();

        if (userId === undefined) {
            return { dispatched: 0 };
        }

        const { now } = ctx;
        const running = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_watchActive", (q) => q.eq("userId", userId).eq("watchActive", true))
            .take(POLL_LIMIT * 2);
        const due = running
            .filter(
                (link) =>
                    link.threadDeleted !== true &&
                    link.watch !== undefined &&
                    link.watch.stoppedAt === undefined &&
                    (link.watchCheckedAt === undefined || now - link.watchCheckedAt >= PR_WATCH_POLL_INTERVAL_MS),
            )
            .toSorted((a, b) => (a.watchCheckedAt ?? 0) - (b.watchCheckedAt ?? 0))
            .slice(0, POLL_LIMIT);

        for (const link of due) {
            // Stamped first: a sweep that runs again before the read lands skips this link. The stamp is the lease.
            await ctx.db.patch("pullRequestThreads", link._id, { watchCheckedAt: now });
            await ctx.scheduler.runAfter(0, internal.source_control.pr_watch_poll.pollWatchedPullRequest, {
                lease: now,
                linkId: link._id,
                startedAt: link.watch?.startedAt ?? now,
            });
        }

        return { dispatched: due.length };
    });

/** What the host read needs from a running watch, on the user's shard. Null when the watch is gone or over. */
export const readWatchForPoll = internalQuery
    .input({ linkId: v.id("pullRequestThreads") })
    .output(v.union(v.null(), v.object({ number: v.number(), repository: v.string(), reviewId: v.optional(v.string()), userId: v.string() })))
    .query(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (link === null || link.watchActive !== true || link.watch === undefined || link.watch.stoppedAt !== undefined) {
            return null;
        }

        return { number: link.number, repository: link.repository, reviewId: link.watch.reviewId, userId: link.userId };
    });

/**
 * Decides one observation against the watch as stored and records it, but only while `lease` is still the link's current
 * read and the watch that was leased (`startedAt`) is still the one running.
 *
 * - none, baseline: the decision's state is stored.
 * - wake: the reasons and the markers the decision set are stored, with `watchPending` holding the reasons for the delivery.
 *   `wakes` and `lastWakeAt` keep their stored values: the delivery counts the wake, so one never delivered cannot end the watch.
 * - end (closed or cap): stored, stamped `stoppedAt`, and `watchActive` is cleared so the person's slot is free.
 */
export const recordWatchObservation = internalMutation
    .input({ lease: v.number(), linkId: v.id("pullRequestThreads"), observation: vObservation, startedAt: v.number() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (
            link === null ||
            link.watchActive !== true ||
            link.watch === undefined ||
            link.watch.stoppedAt !== undefined ||
            link.watch.startedAt !== args.startedAt ||
            link.watchCheckedAt !== args.lease
        ) {
            return null;
        }

        const previous = stateOf(link);
        const decision = decideWatch(previous, args.observation, ctx.now);
        const { startedAt } = link.watch;

        if (decision.action === "end") {
            const stored = storedWatchOf({ ...decision.state, startedAt, stoppedAt: ctx.now });

            await ctx.db.patch("pullRequestThreads", link._id, { watch: stored.watch, watchActive: false, watchPending: stored.watchPending ?? [] });

            return null;
        }

        // A wake is not delivered yet: its reasons stay pending with the markers the decision set, but the count and the cooldown
        // keep their stored values, so an undelivered wake never uses up the cap. The delivery counts the wake when it happens.
        const stored = storedWatchOf({
            ...decision.state,
            startedAt,
            ...(decision.action === "wake" && { lastWakeAt: previous.lastWakeAt, pending: decision.reasons, wakes: previous.wakes }),
        });

        await ctx.db.patch("pullRequestThreads", link._id, { watch: stored.watch, watchPending: stored.watchPending ?? [] });

        return null;
    });

/** One host read for one watched link, with the person's own token. */
export const pollWatchedPullRequest = internalAction
    .input({ lease: v.number(), linkId: v.id("pullRequestThreads"), startedAt: v.number() })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const target = await ctx.runQuery(internal.source_control.pr_watch_poll.readWatchForPoll, { linkId: args.linkId });

        if (target === null) {
            return null;
        }

        const token = await resolveGithubToken(ctx, target.userId);
        const outcome = await readFromHost(DEVELOP_DRIVER, token, async (request): Promise<{ observation: PullRequestObservation }> => {
            const ref = { number: target.number, repository: target.repository };
            const detail = await DEVELOP_DRIVER.getPullRequest(request, ref);
            const watcherLogin = await signedInLogin(request);

            // A pull request that is no longer open ends the watch: nothing else about it is read.
            if (detail.state !== "open") {
                return {
                    observation: {
                        checks: "pending",
                        failingCheckNames: [],
                        headSha: detail.headSha,
                        mergeable: "unknown",
                        reviews: [],
                        state: detail.state,
                        watcherLogin,
                    },
                };
            }

            const [summary, reviews] = await Promise.all([
                DEVELOP_DRIVER.listChecks(request, ref, detail.headSha),
                DEVELOP_DRIVER.listReviews(request, ref, target.reviewId === undefined ? undefined : { seenId: target.reviewId }),
            ]);
            const { failing, status } = checksOf(summary);

            return {
                observation: {
                    checks: status,
                    failingCheckNames: failing.slice(0, MAX_FAILING_NAMES).map((check) => check.name.slice(0, MAX_NAME_LENGTH)),
                    headSha: detail.headSha,
                    mergeable: mergeableOf(detail.mergeState),
                    reviews: reviews.items.slice(0, MAX_REVIEWS).map((review) => {
                        return { authorLogin: review.authorLogin, id: review.id };
                    }),
                    state: detail.state,
                    watcherLogin,
                },
            };
        });

        if (outcome.status === "ok") {
            await ctx.runMutation(internal.source_control.pr_watch_poll.recordWatchObservation, {
                lease: args.lease,
                linkId: args.linkId,
                observation: outcome.observation,
                startedAt: args.startedAt,
            });
        }

        return null;
    });
