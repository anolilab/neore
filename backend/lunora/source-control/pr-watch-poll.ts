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
 * A failed read is noted (`recordWatchFailure`: one event, and the status and run length on the link) but never changes the watch's
 * decision state; the watchdog poll retries it. Five terminal failures in a row (not found, forbidden, sign-in needed, not
 * connected) end the watch; a transient one breaks the run.
 * A wake is recorded as its owed reasons in `watchPending` and sends nothing; `wakes` and `lastWakeAt` keep their stored values,
 * so the delivery, which clears `watchPending`, is what counts the wake.
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
import { HostApiError, type HostRequest } from "./origin-fetch";
import { failureOf, readFromHost, type ReadFailure, type ReadOutcome } from "./read-host";
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
/** Reviews kept when no seen review bounds the list. The host lists newest first and the cut keeps the head: only the oldest are dropped, which the decision never needs. */
const MAX_REVIEWS = 100;

/** Failures that retrying cannot cure, and how many in a row end the watch. Transient ones (host error, rate limit) retry for good. */
const TERMINAL_FAILURES = new Set<ReadFailure>(["forbidden", "needs_reconnect", "not_connected", "not_found"]);

export const PR_WATCH_MAX_TERMINAL_FAILURES = 5;

/** A `watchCheckedAt` no poll carries: what a recorded poll leaves behind. */
const CONSUMED_LEASE = -1;

const NOT_PASSING = new Set<CheckState>(["cancelled", "failure"]);

const vObservation = v.object({
    checks: v.union(v.literal("failing"), v.literal("passing"), v.literal("pending")),
    failingCheckNames: v.array(v.string()),
    headSha: v.string(),
    mergeable: v.union(v.literal("clean"), v.literal("conflicting"), v.literal("unknown")),
    reviews: v.array(v.object({ authorLogin: v.string(), id: v.string() })),
    seenReviewBeyondRead: v.optional(v.union(v.literal("gone"), v.literal("present"), v.literal("unknown"))),
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
        { lease: now, linkId: link._id, startedAt: link.watch?.startedAt ?? now, ...(link.watchRun !== undefined && { run: link.watchRun }) },
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

const vReadFailure = v.union(
    v.literal("forbidden"),
    v.literal("host_error"),
    v.literal("needs_reconnect"),
    v.literal("not_connected"),
    v.literal("not_found"),
    v.literal("rate_limited"),
);

/**
 * Notes a host read that failed, only while `lease` is still the link's current read: one metadata-only event (the link, the
 * status and the attempt) and the status on the link, so a watch whose reads keep failing shows it. The watch's decision state,
 * its wake count and its lease are untouched: the retry is the watchdog already armed with the lease.
 */
export const recordWatchFailure = internalMutation
    .input({ lease: v.number(), linkId: v.id("pullRequestThreads"), run: v.optional(v.string()), startedAt: v.number(), status: vReadFailure })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (
            link === null ||
            link.watchActive !== true ||
            link.watch === undefined ||
            link.watch.stoppedAt !== undefined ||
            link.watch.startedAt !== args.startedAt ||
            link.watchRun !== args.run ||
            link.watchCheckedAt !== args.lease
        ) {
            return null;
        }

        // Counts the run of failures of one kind: a transient failure after terminal ones (or the reverse) starts a new run at 1, so only
        // five terminal failures in a row end the watch, and a brief outage between them breaks the run. A landed read resets it to 0.
        const previous = link.watchReadFailure;
        const sameRun = previous !== undefined && previous.attempts > 0 && TERMINAL_FAILURES.has(previous.status) === TERMINAL_FAILURES.has(args.status);
        const attempt = sameRun ? previous.attempts + 1 : 1;

        // The lease is consumed (-1 is no poll's lease): a repeat of this poll is rejected, and the retry is the watchdog's.
        await ctx.db.patch("pullRequestThreads", link._id, {
            watchCheckedAt: CONSUMED_LEASE,
            watchReadFailure: { at: ctx.now, attempts: attempt, status: args.status },
        });
        ctx.log.event("develop.watch_poll_failed", { attempt, linkId: String(link._id), status: args.status });

        // A watch that can never be read (the pull request or repository is gone, access was withdrawn) must not hold a slot for good.
        if (TERMINAL_FAILURES.has(args.status) && attempt >= PR_WATCH_MAX_TERMINAL_FAILURES) {
            await ctx.db.patch("pullRequestThreads", link._id, { watch: { ...link.watch, stoppedAt: ctx.now }, watchActive: false });
            ctx.log.event("develop.watch_ended", { attempt, linkId: String(link._id), reason: "unreadable", status: args.status });
        }

        return null;
    });

/**
 * What the host read needs from a running watch, on the user's shard. Null when the watch is gone or over, or when `lease` or
 * `startedAt` or `run` is no longer the link's own: the poll is stale and must not reach the host.
 */
export const readWatchForPoll = internalQuery
    .input({ lease: v.number(), linkId: v.id("pullRequestThreads"), run: v.optional(v.string()), startedAt: v.number() })
    .output(v.union(v.null(), v.object({ number: v.number(), repository: v.string(), reviewId: v.optional(v.string()), userId: v.string() })))
    .query(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (
            link === null ||
            link.watchActive !== true ||
            link.watch === undefined ||
            link.watch.stoppedAt !== undefined ||
            link.watch.startedAt !== args.startedAt ||
            link.watchRun !== args.run ||
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
    .input({
        lease: v.number(),
        linkId: v.id("pullRequestThreads"),
        loginFailure: v.optional(vReadFailure),
        observation: vObservation,
        run: v.optional(v.string()),
        startedAt: v.number(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (
            link === null ||
            link.watchActive !== true ||
            link.watch === undefined ||
            link.watch.stoppedAt !== undefined ||
            link.watch.startedAt !== args.startedAt ||
            link.watchRun !== args.run ||
            link.watchCheckedAt !== args.lease
        ) {
            return null;
        }

        const previous = stateOf(link);
        const decision = decideWatch(previous, args.observation, ctx.now);

        // The signed-in login could not be read; the rest of the read stands and counts as no failure of the watch.
        if (args.loginFailure !== undefined) {
            ctx.log.event("develop.watch_login_failed", { linkId: String(link._id), status: args.loginFailure });
        }

        const { startedAt } = link.watch;

        if (decision.action === "end") {
            const stored = storedWatchOf({ ...decision.state, startedAt, stoppedAt: ctx.now });

            await ctx.db.patch("pullRequestThreads", link._id, { watch: stored.watch, watchActive: false, watchPending: stored.watchPending ?? [] });
            ctx.log.event("develop.watch_ended", { linkId: String(link._id), reason: decision.reason });

            return null;
        }

        // A wake is not delivered yet: its reasons stay pending with the markers the decision set, but the count and the cooldown
        // keep their stored values, so an undelivered wake never uses up the cap. The delivery counts the wake when it happens.
        // The lease identity is consumed with the release, so a repeat of this poll (or a late one) no longer matches.
        const release = { watchCheckedAt: CONSUMED_LEASE, watchLeaseUntil: ctx.now + PR_WATCH_POLL_INTERVAL_MS };
        const stored = storedWatchOf({
            ...decision.state,
            startedAt,
            ...(decision.action === "wake" && { lastWakeAt: previous.lastWakeAt, pending: decision.reasons, wakes: previous.wakes }),
        });

        // The lease ends with the record, whenever the read took: the next poll is armed from here, one interval later.
        await ctx.db.patch("pullRequestThreads", link._id, {
            ...release,
            watch: stored.watch,
            watchPending: stored.watchPending ?? [],
            ...(link.watchReadFailure !== undefined && { watchReadFailure: { ...link.watchReadFailure, attempts: 0 } }),
        });
        await runAfterOnShard(ctx.scheduler, PR_WATCH_POLL_INTERVAL_MS, internal.source_control.pr_watch_poll.pollWatchLink, { linkId: link._id }, link.userId);

        return null;
    });

export interface WatchTarget {
    number: number;
    repository: string;
    reviewId?: string;
    userId: string;
}

/** Extra tries of the record alone, with no delay. */
const RECORD_RETRIES = 2;

/**
 * Records an observation already read. A record that throws (a transient write failure rolls back, so the lease is still the
 * link's) is tried again with the SAME observation, never a new host read: a second read could show passing checks and lose the
 * failing ones the first read saw. Every try keeps the mutation's lease and run checks. Past the bound the error stands, and the
 * watchdog poll is the retry.
 */
const recordWithRetry = async (
    record: (observation: PullRequestObservation, loginFailure?: ReadFailure) => Promise<unknown>,
    observation: PullRequestObservation,
    loginFailure?: ReadFailure,
): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
        try {
            await (loginFailure === undefined ? record(observation) : record(observation, loginFailure));

            return;
        } catch (error) {
            if (attempt >= RECORD_RETRIES) {
                throw error;
            }
        }
    }
};

/** The steps of one poll, apart from where they run, so their order is pinned by a test. */
export interface WatchPollSteps {
    /** Notes a host read that failed: nothing else changes, and the retry is the one already armed. */
    fail: (status: ReadFailure) => Promise<unknown>;
    /** The watch's target while this poll's lease and watch are still the link's own; null once they are not. */
    read: () => Promise<WatchTarget | null>;
    readHost: (target: WatchTarget, token: GithubTokenOutcome) => Promise<ReadOutcome<{ loginFailure?: ReadFailure; observation: PullRequestObservation }>>;
    record: (observation: PullRequestObservation, loginFailure?: ReadFailure) => Promise<unknown>;
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
        await recordWithRetry(steps.record, outcome.observation, outcome.loginFailure);
    } else {
        await steps.fail(outcome.status);
    }
};

/** What `observeWatched` calls out to, so a test can count the calls. */
export interface ObserveDependencies {
    driver: Pick<HostDriver, "getPullRequest" | "listChecks" | "listReviews" | "reviewExists">;
    login: (request: HostRequest) => Promise<string>;
}

const LIVE: ObserveDependencies = { driver: DEVELOP_DRIVER, login: signedInLogin };

/** The signed-in login, or why it could not be read. Only a refusal other than 401 is told apart; anything else goes up. */
const readLogin = async (dependencies: ObserveDependencies, request: HostRequest): Promise<{ failure?: ReadFailure; name: string }> => {
    try {
        return { name: await dependencies.login(request) };
    } catch (error) {
        if (!(error instanceof HostApiError) || error.status === 401) {
            throw error;
        }

        return { failure: failureOf(error), name: "" };
    }
};

/**
 * What a direct read of the seen review finds: it exists (beyond the pages read), it was deleted (not found), or the read failed
 * for another reason, so nothing is known. A 401 goes up so the token is renewed once, like any other read.
 */
const seenReviewState = async (
    dependencies: ObserveDependencies,
    request: HostRequest,
    ref: { number: number; repository: string },
    reviewId: string | undefined,
): Promise<"gone" | "present" | "unknown"> => {
    if (reviewId === undefined) {
        return "unknown";
    }

    try {
        await dependencies.driver.reviewExists(request, ref, reviewId);

        return "present";
    } catch (error) {
        if (!(error instanceof HostApiError) || error.status === 401) {
            throw error;
        }

        return failureOf(error) === "not_found" ? "gone" : "unknown";
    }
};

/**
 * One watched pull request as the host says it now. The pull request is read first: one that is closed or merged ends the
 * watch, which needs nothing else, so the signed-in login (only needed to leave the watcher's own reviews out) is read only
 * for a watch that goes on.
 */
export const observeWatched = async (
    request: HostRequest,
    target: WatchTarget,
    dependencies: ObserveDependencies = LIVE,
): Promise<{ loginFailure?: ReadFailure; observation: PullRequestObservation }> => {
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

    // The login is its own read: a refusal of `/user` says nothing about the pull request, so it must not count against the watch.
    // With an empty login `decideWatch` counts every listed review as someone else's, so a review newer than the marker wakes the
    // watch and moves the marker, the watcher's own included: a spurious wake is accepted over a missed review. A 401 still goes
    // up, so the token is renewed once like any other read.
    const [login, summary, reviews] = await Promise.all([
        readLogin(dependencies, request),
        dependencies.driver.listChecks(request, ref, detail.headSha),
        dependencies.driver.listReviews(request, ref, target.reviewId === undefined ? undefined : { seenId: target.reviewId }),
    ]);
    const watcherLogin = login.name;
    const { failing, status } = checksOf(summary);
    const { items, total } = reviews;
    const seenAt = target.reviewId === undefined ? -1 : items.findIndex((review) => review.id === target.reviewId);
    // Through the seen review, however many are newer (those are what the decision needs); with none seen, the newest bound.
    const kept = seenAt === -1 ? items.slice(0, MAX_REVIEWS) : items.slice(0, seenAt + 1);
    const markerBeyondRead = target.reviewId !== undefined && seenAt === -1 && items.length < total;

    return {
        ...(login.failure !== undefined && { loginFailure: login.failure }),
        observation: {
            checks: status,
            failingCheckNames: failing.slice(0, MAX_FAILING_NAMES).map((check) => check.name.slice(0, MAX_NAME_LENGTH)),
            headSha: detail.headSha,
            mergeable: mergeableOf(detail.mergeState),
            reviews: kept.map((review) => {
                return { authorLogin: review.authorLogin, id: review.id };
            }),
            state: detail.state,
            watcherLogin,
            // The marker lies beyond the pages the host read: what a direct read of it found decides what the list means (`decideWatch`).
            ...(markerBeyondRead && { seenReviewBeyondRead: await seenReviewState(dependencies, request, ref, target.reviewId) }),
        },
    };
};

const readObservation = async (
    target: WatchTarget,
    token: GithubTokenOutcome,
): Promise<ReadOutcome<{ loginFailure?: ReadFailure; observation: PullRequestObservation }>> =>
    await readFromHost(DEVELOP_DRIVER, token, async (request) => await observeWatched(request, target));

/** One host read for one watched link, with the person's own token. */
export const pollWatchedPullRequest = internalAction
    .input({ lease: v.number(), linkId: v.id("pullRequestThreads"), run: v.optional(v.string()), startedAt: v.number() })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const key = { lease: args.lease, linkId: args.linkId, startedAt: args.startedAt, ...(args.run !== undefined && { run: args.run }) };

        await runWatchPoll({
            fail: async (status) => await ctx.runMutation(internal.source_control.pr_watch_poll.recordWatchFailure, { ...key, status }),
            read: async () => await ctx.runQuery(internal.source_control.pr_watch_poll.readWatchForPoll, key),
            readHost: readObservation,
            record: async (observation, loginFailure) =>
                await ctx.runMutation(internal.source_control.pr_watch_poll.recordWatchObservation, {
                    ...key,
                    observation,
                    ...(loginFailure !== undefined && { loginFailure }),
                }),
            token: async (userId) => await resolveGithubToken(ctx, userId),
        });

        return null;
    });
