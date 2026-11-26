/**
 * The poller of pull request watches (`pr-watch.ts` starts one, `pr-watch-logic.ts` decides what a read means). A shard
 * sweep leases the running watches whose last read is old enough (stamping `watchCheckedAt` in the same transaction, so
 * the next sweep skips them) and schedules one action per link. The action reads the pull request with the person's
 * token and hands the observation to a mutation, which decides against the watch as it is stored now and records the
 * result only while its lease is still the link's current one and the same watch is still running. A late answer, or one
 * for a watch that was stopped or restarted meanwhile, is dropped.
 *
 * Each leased watch also schedules its own next poll on its owner's shard (`pollWatchLink`), so a watch is polled whether or
 * not its shard is active; the sweep is the backstop that restarts a chain that was lost.
 * A failed read changes nothing: the lease stamp alone makes the next try wait for the interval.
 * This file records a wake (`lastWakeAt`, the count and the owed reasons in `watchPending`) and sends nothing: the
 * delivery clears `watchPending` once it has happened.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { type GithubTokenOutcome, resolveGithubToken } from "../connectors/lib/github-token";
import { currentUserShard } from "../lib/shard-context";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { rollupOf } from "./checks-logic";
import { DEVELOP_DRIVER } from "./develop-driver";
import type { HostDriver } from "./driver";
import { signedInLogin } from "./drivers/github";
import type { PullRequestObservation } from "./pr-watch-logic";
import { decideWatch, stateOf, storedWatchOf } from "./pr-watch-logic";
import type { HostRequest } from "./origin-fetch";
import { readFromHost, type ReadOutcome } from "./read-host";
import type { CheckRun, CheckState, CheckSummary, MergeState } from "./types";

/** A running watch is read again once its last read is this old. */
export const PR_WATCH_POLL_INTERVAL_MS = 3 * 60 * 1000;
/**
 * How long a leased read may take before the watch is polled again: the lease lasts until the read records, or this long if it
 * never does (a failed or lost read). A slow read therefore keeps its lease and its answer; the poll after it starts only once
 * the lease has ended.
 */
export const PR_WATCH_LEASE_MS = 10 * 60 * 1000;
/** Watches one sweep leases, so one person's host calls stay bounded whatever the person's limit is. */
const POLL_LIMIT = 10;
/** Running watches read per page of the sweep, and pages per sweep. */
const SCAN_PAGE_SIZE = 50;
const SCAN_PAGES = 4;
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
        // The running watches are paged through until enough are due or the pages run out, so a due watch is reached whatever its
        // place in the index. Both bounds are fixed: a person holds few running watches, but nothing here relies on that.
        const due: Doc<"pullRequestThreads">[] = [];
        let cursor: string | null = null;

        for (let pages = 0; pages < SCAN_PAGES && due.length < POLL_LIMIT; pages += 1) {
            const page = await ctx.db
                .query("pullRequestThreads")
                .withIndex("by_user_and_watchActive", (q) => q.eq("userId", userId).eq("watchActive", true))
                .paginate({ cursor, numItems: SCAN_PAGE_SIZE });

            due.push(...page.page.filter((link) => isDue(link, now)));

            if (page.isDone) {
                break;
            }

            cursor = page.continueCursor;
        }

        // Oldest read first, so a watch is not starved by the ones read before it.
        due.sort((a, b) => nextPollAt(a) - nextPollAt(b));
        due.length = Math.min(due.length, POLL_LIMIT);

        for (const link of due) {
            await leaseWatch(ctx, link, now);
        }

        return { dispatched: due.length };
    });

/** When the watch may next be polled: the end of its lease, or of the interval after its last recorded read. */
const nextPollAt = (link: Doc<"pullRequestThreads">): number =>
    link.watchLeaseUntil ?? (link.watchCheckedAt === undefined ? 0 : link.watchCheckedAt + PR_WATCH_POLL_INTERVAL_MS);

/** Whether the link holds a running watch that no read holds the lease of, and whose interval has passed. */
const isDue = (link: Doc<"pullRequestThreads">, now: number): boolean =>
    link.threadDeleted !== true && link.watchActive === true && link.watch !== undefined && link.watch.stoppedAt === undefined && now >= nextPollAt(link);

/**
 * Leases a running watch for one host read and keeps its own next poll scheduled on its owner's shard, so a person whose
 * shard goes quiet is still polled (the housekeeping sweep only visits active shards and is the backstop). The next poll is
 * armed here, with the lease, not when the read lands: a read that fails or never lands still has its successor.
 */
const leaseWatch = async (ctx: Pick<MutationCtx, "db" | "scheduler">, link: Doc<"pullRequestThreads">, now: number): Promise<void> => {
    // Stamped first: a sweep or poll that runs again before the read lands skips this link. The stamp is the lease.
    await ctx.db.patch("pullRequestThreads", link._id, { watchCheckedAt: now, watchLeaseUntil: now + PR_WATCH_LEASE_MS });
    await runAfterOnShard(
        ctx.scheduler,
        0,
        internal.source_control.pr_watch_poll.pollWatchedPullRequest,
        { lease: now, linkId: link._id, startedAt: link.watch?.startedAt ?? now },
        link.userId,
    );
    // The watchdog: the read's record arms the next poll itself, so this one only matters when the read never records. It does
    // nothing while the lease is still held (a slow read) or already released.
    await runAfterOnShard(ctx.scheduler, PR_WATCH_LEASE_MS, internal.source_control.pr_watch_poll.pollWatchLink, { linkId: link._id }, link.userId);
};

/**
 * The watch's own poll: leases it when it is due and arms the next one. A watch that is stopped, ended or deleted, or that a
 * sweep or an earlier poll already leased inside the interval, does nothing (the lease holder armed its own successor), so
 * competing chains converge to one and a poll never runs twice at once.
 */
export const pollWatchLink = internalMutation
    .input({ linkId: v.id("pullRequestThreads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (link !== null && isDue(link, ctx.now)) {
            await leaseWatch(ctx, link, ctx.now);
        }

        return null;
    });

/**
 * What the host read needs from a running watch, on the user's shard. Null when the watch is gone or over, or when `lease` or
 * `startedAt` is no longer the link's own: the poll is stale and must not reach the host.
 */
export const readWatchForPoll = internalQuery
    .input({ lease: v.number(), linkId: v.id("pullRequestThreads"), startedAt: v.number() })
    .output(v.union(v.null(), v.object({ number: v.number(), repository: v.string(), reviewId: v.optional(v.string()), userId: v.string() })))
    .query(async ({ args, ctx }) => {
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
        const release = { watchLeaseUntil: ctx.now + PR_WATCH_POLL_INTERVAL_MS };
        const stored = storedWatchOf({
            ...decision.state,
            startedAt,
            ...(decision.action === "wake" && { lastWakeAt: previous.lastWakeAt, pending: decision.reasons, wakes: previous.wakes }),
        });

        // The lease ends with the record, whenever the read took: the next poll is armed from here, one interval later.
        await ctx.db.patch("pullRequestThreads", link._id, { ...release, watch: stored.watch, watchPending: stored.watchPending ?? [] });
        await runAfterOnShard(ctx.scheduler, PR_WATCH_POLL_INTERVAL_MS, internal.source_control.pr_watch_poll.pollWatchLink, { linkId: link._id }, link.userId);

        return null;
    });

export interface WatchTarget {
    number: number;
    repository: string;
    reviewId?: string;
    userId: string;
}

/** The steps of one poll, apart from where they run, so their order is pinned by a test. */
export interface WatchPollSteps {
    /** The watch's target while this poll's lease and watch are still the link's own; null once they are not. */
    read: () => Promise<WatchTarget | null>;
    readHost: (target: WatchTarget, token: GithubTokenOutcome) => Promise<ReadOutcome<{ observation: PullRequestObservation }>>;
    record: (observation: PullRequestObservation) => Promise<unknown>;
    token: (userId: string) => Promise<GithubTokenOutcome>;
}

/**
 * One poll: reads the target, gets the token, and reads the target AGAIN right before the host call, so a watch stopped or
 * restarted while the token was fetched costs no host request. The answer is recorded only while its lease still matches
 * (`recordWatchObservation`), which drops a result for a watch stopped during the call.
 */
export const runWatchPoll = async (steps: WatchPollSteps): Promise<void> => {
    const target = await steps.read();

    if (target === null) {
        return;
    }

    const token = await steps.token(target.userId);

    if ((await steps.read()) === null) {
        return;
    }

    const outcome = await steps.readHost(target, token);

    if (outcome.status === "ok") {
        await steps.record(outcome.observation);
    }
};

/** What `observeWatched` calls out to, so a test can count the calls. */
export interface ObserveDependencies {
    driver: Pick<HostDriver, "getPullRequest" | "listChecks" | "listReviews">;
    login: (request: HostRequest) => Promise<string>;
}

const LIVE: ObserveDependencies = { driver: DEVELOP_DRIVER, login: signedInLogin };

/**
 * One watched pull request as the host says it now. The pull request is read first: one that is closed or merged ends the
 * watch, which needs nothing else, so the signed-in login (only needed to leave the watcher's own reviews out) is read only
 * for a watch that goes on.
 */
export const observeWatched = async (
    request: HostRequest,
    target: WatchTarget,
    dependencies: ObserveDependencies = LIVE,
): Promise<{ observation: PullRequestObservation }> => {
    const ref = { number: target.number, repository: target.repository };
    const detail = await dependencies.driver.getPullRequest(request, ref);

    if (detail.state !== "open") {
        return {
            observation: {
                checks: "pending",
                failingCheckNames: [],
                headSha: detail.headSha,
                mergeable: "unknown",
                reviews: [],
                state: detail.state,
                watcherLogin: "",
            },
        };
    }

    const [watcherLogin, summary, reviews] = await Promise.all([
        dependencies.login(request),
        dependencies.driver.listChecks(request, ref, detail.headSha),
        dependencies.driver.listReviews(request, ref, target.reviewId === undefined ? undefined : { seenId: target.reviewId }),
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
};

const readObservation = async (target: WatchTarget, token: GithubTokenOutcome): Promise<ReadOutcome<{ observation: PullRequestObservation }>> =>
    await readFromHost(DEVELOP_DRIVER, token, async (request) => await observeWatched(request, target));

/** One host read for one watched link, with the person's own token. */
export const pollWatchedPullRequest = internalAction
    .input({ lease: v.number(), linkId: v.id("pullRequestThreads"), startedAt: v.number() })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const key = { lease: args.lease, linkId: args.linkId, startedAt: args.startedAt };

        await runWatchPoll({
            read: async () => await ctx.runQuery(internal.source_control.pr_watch_poll.readWatchForPoll, key),
            readHost: readObservation,
            record: async (observation) => await ctx.runMutation(internal.source_control.pr_watch_poll.recordWatchObservation, { ...key, observation }),
            token: async (userId) => await resolveGithubToken(ctx, userId),
        });

        return null;
    });
