/**
 * The wake turn of a pull request watch: what the poller recorded (`pr-watch-poll.ts` keeps the owed reasons in
 * `watchPending`) is delivered to the linked thread as one headless turn. The poller never sends; this does.
 *
 * Two steps, so the long part is off the user's short-job scheduler lane:
 *
 * 1. `startWatchWake` (a mutation, scheduled by the poller) CLAIMS the delivery. It refuses when the watch is no longer the one
 *    that was polled (run and start), the cap of wakes is reached, the cooldown has not passed, another delivery holds the
 *    lease, the thread cannot take a run now (locked, deleted, not the owner's, a reply streaming), the account may not run
 *    unattended turns, or its daily limits are spent. Only then is the round CHARGED (as a task or trigger run is, `tasks/account.ts`),
 *    the lease taken and the turn enqueued on the jobs queue under a claim-once id. A refusal changes nothing: the reasons stay
 *    pending and the next poll that still owes them tries again.
 * 2. `runWatchWake` (the job) runs the turn in the thread, then `finishWatchWake` counts the wake and clears what it delivered.
 *    The wake is COUNTED only after the turn ran; a failed turn releases the lease and leaves the reasons pending and the count
 *    where it was.
 *
 * A reason is cleared only if no newer occurrence of its kind was recorded while the turn ran: each reason is delivered with the
 * marker of the occurrence it came from (the failing head, the conflicting head, the newest review), and a marker that has moved
 * since means another occurrence is owed, which stays pending for the next delivery.
 *
 * Reads and writes of watch state happen on the owner's shard only (`currentUserShard`, `runAfterOnShard`, `enqueueJob`).
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { runHeadlessAgent } from "../chat/lib/headless-run";
import { loadEligibleThread } from "../devices/internal";
import { enqueueJob } from "../lib/job-queue";
import { JOB_LEASE_MS } from "../lib/job-once";
import { isThreadLocked } from "../lib/thread-lock";
import { chargeRound, loadTaskAccount, taskAccessProblem } from "../tasks/account";
import { PR_WATCH_MAX_WAKES, PR_WATCH_WAKE_COOLDOWN_MS, type WatchWakeReason } from "./pr-watch-logic";

/**
 * How long a claimed delivery holds the link. The turn is a queue job: one invocation is capped at 15 minutes, and the claim-once
 * wrapper (`lib/job-once.ts`) already allows `JOB_LEASE_MS` for a delivery and never starts a second run of the same job, so a
 * live turn cannot outlast that. This is that bound plus five minutes for the queue's own delay before the job starts, so a second
 * delivery can never begin while the first still runs. A job that dies leaves the lease to lapse, and the claim's `onLapse` releases it sooner.
 */
export const PR_WATCH_WAKE_LEASE_MS = JOB_LEASE_MS + 5 * 60 * 1000;

const vReason = v.union(v.literal("checks"), v.literal("conflict"), v.literal("review"));
const vMarkers = v.object({ checks: v.optional(v.string()), conflict: v.optional(v.string()), review: v.optional(v.string()) });

type Markers = { checks?: string; conflict?: string; review?: string };

const REASON_TEXT: Record<WatchWakeReason, string> = {
    checks: "checks are failing on its latest commit",
    conflict: "it now conflicts with its base branch",
    review: "someone else reviewed it",
};

/**
 * The note the thread gets. Only what the watch knows (which pull request, which kinds of occurrence): nothing the host sent, so there
 * is no untrusted text in it. The agent reads the details with its own pull request tools.
 */
export const wakePrompt = (target: { number: number; repository: string }, reasons: ReadonlyArray<WatchWakeReason>): string =>
    [
        `[Pull request watch] ${target.repository}#${String(target.number)}: ${reasons.map((reason) => REASON_TEXT[reason]).join("; ")}.`,
        "Read the pull request and its failing checks with your pull request tools, then act on what the person asked of this thread, or tell them what changed. Do not merge.",
    ].join("\n");

const key = { linkId: v.id("pullRequestThreads"), run: v.optional(v.string()), startedAt: v.number() };

const markersOf = (watch: { checksHeadSha?: string; conflictHeadSha?: string; reviewId?: string }): Markers => {
    return {
        ...(watch.checksHeadSha !== undefined && { checks: watch.checksHeadSha }),
        ...(watch.conflictHeadSha !== undefined && { conflict: watch.conflictHeadSha }),
        ...(watch.reviewId !== undefined && { review: watch.reviewId }),
    };
};

const currentMarker = (watch: { checksHeadSha?: string; conflictHeadSha?: string; reviewId?: string }, reason: WatchWakeReason): string | undefined =>
    markersOf(watch)[reason];

/**
 * Claims the delivery of the link's pending reasons and enqueues the turn, or does nothing: the watch is not the polled one, nothing
 * is pending, the cap or the cooldown forbids a wake, another delivery holds the lease, the thread cannot take a run now, the account
 * may not run unattended turns, or a daily limit is spent (the round is then not charged and nothing is counted).
 */
export const startWatchWake = internalMutation
    .input(key)
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (
            link === null ||
            link.threadDeleted === true ||
            link.watchActive !== true ||
            link.watch === undefined ||
            link.watch.stoppedAt !== undefined ||
            link.watch.startedAt !== args.startedAt ||
            link.watchRun !== args.run
        ) {
            return false;
        }

        const reasons = link.watchPending ?? [];

        if (reasons.length === 0 || (link.watch.wakes ?? 0) >= PR_WATCH_MAX_WAKES) {
            return false;
        }

        if (link.watch.lastWakeAt !== undefined && ctx.now - link.watch.lastWakeAt < PR_WATCH_WAKE_COOLDOWN_MS) {
            return false;
        }

        if (link.watchWakeLeaseUntil !== undefined && ctx.now < link.watchWakeLeaseUntil) {
            return false;
        }

        const thread = await loadEligibleThread(ctx, link.threadId, link.userId);

        // A reply that is streaming holds the thread's run lock: the turn waits, and the reasons stay pending for the next poll.
        const liveReply = thread
            ? await ctx.db.persistentStreams.findFirst({ where: { status: { in: ["pending", "streaming"] }, threadId: thread._id as string } })
            : null;

        if (thread === null || isThreadLocked(thread) || thread.deleted === true || liveReply !== null) {
            return false;
        }

        // An unattended turn answers to the same limits as a task or trigger run: the account must be allowed to run them, and the round
        // is charged to the daily limits BEFORE the model is asked. A limit that is spent leaves the reasons pending, uncounted.
        const account = await loadTaskAccount(ctx, link.userId);

        if (taskAccessProblem(account) !== undefined || account === null || !(await chargeRound(ctx, link.userId, account))) {
            return false;
        }

        const claim = ctx.now + PR_WATCH_WAKE_LEASE_MS;

        await ctx.db.patch("pullRequestThreads", link._id, { watchWakeLeaseUntil: claim });

        const turn = {
            claim,
            linkId: link._id,
            markers: markersOf(link.watch),
            model: thread.model || DEFAULT_CHAT_MODEL,
            number: link.number,
            organizationId: thread.organizationId ?? null,
            reasons,
            repository: link.repository,
            threadId: String(thread._id),
            userId: link.userId,
            ...(link.watchRun !== undefined && { run: link.watchRun }),
            startedAt: args.startedAt,
        };

        // On the jobs queue, once: a redelivery never runs a second paid turn, and a job that dies frees the lease (`releaseWatchWake`).
        await enqueueJob(internal.source_control.pr_watch_wake.runWatchWake, turn, {
            once: {
                jobId: `pr-watch-wake:${String(link._id)}:${String(claim)}`,
                onLapse: {
                    args: { claim, linkId: link._id, startedAt: args.startedAt, ...(link.watchRun !== undefined && { run: link.watchRun }) },
                    ref: internal.source_control.pr_watch_wake.releaseWatchWake,
                },
                userId: link.userId,
            },
            shardKey: link.userId,
        });

        return true;
    });

/** Whether the delivery named by `claim` still holds the link's lease on a watch that is still the one polled. */
export const isWatchWakeCurrent = internalQuery
    .input({ ...key, claim: v.number() })
    .output(v.boolean())
    .query(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        return (
            link !== null &&
            link.watchWakeLeaseUntil === args.claim &&
            link.watchActive === true &&
            link.watch !== undefined &&
            link.watch.stoppedAt === undefined &&
            link.watch.startedAt === args.startedAt &&
            link.watchRun === args.run
        );
    });

/**
 * Ends a delivery. Releases the lease it holds (a lease that is no longer this claim's is left alone). A delivered wake is counted
 * once (`wakes`, `lastWakeAt`) and its reasons leave `watchPending`, only while the same watch still runs, and only a reason whose
 * occurrence is the one delivered (`markers`): one recorded again while the turn ran stays pending. A failed one changes nothing else.
 */
export const finishWatchWake = internalMutation
    .input({ ...key, claim: v.number(), delivered: v.boolean(), markers: vMarkers, reasons: v.array(vReason) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (link === null || link.watchWakeLeaseUntil !== args.claim) {
            return null;
        }

        const same =
            link.watchActive === true &&
            link.watch !== undefined &&
            link.watch.stoppedAt === undefined &&
            link.watch.startedAt === args.startedAt &&
            link.watchRun === args.run;

        if (!args.delivered || !same || link.watch === undefined) {
            await ctx.db.patch("pullRequestThreads", link._id, { watchWakeLeaseUntil: 0 });

            return null;
        }

        const { watch } = link;

        await ctx.db.patch("pullRequestThreads", link._id, {
            watch: { ...watch, lastWakeAt: ctx.now, wakes: (watch.wakes ?? 0) + 1 },
            watchPending: (link.watchPending ?? []).filter((reason) => !args.reasons.includes(reason) || currentMarker(watch, reason) !== args.markers[reason]),
            watchWakeLeaseUntil: 0,
        });

        return null;
    });

/** Frees the lease of a delivery whose job died (the claim-once lapse handler): nothing is counted, the reasons stay pending. */
export const releaseWatchWake = internalMutation
    .input({ ...key, claim: v.number(), claimKey: v.optional(v.string()) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (link !== null && link.watchWakeLeaseUntil === args.claim) {
            await ctx.db.patch("pullRequestThreads", link._id, { watchWakeLeaseUntil: 0 });
        }

        return null;
    });

/** The job: runs the turn in the thread, then counts it. A turn that fails is released uncounted, for a later try. */
export const runWatchWake = internalAction
    .input({
        ...key,
        claim: v.number(),
        markers: vMarkers,
        model: v.string(),
        number: v.number(),
        organizationId: v.union(v.string(), v.null()),
        reasons: v.array(vReason),
        repository: v.string(),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const identity = { claim: args.claim, linkId: args.linkId, startedAt: args.startedAt, ...(args.run !== undefined && { run: args.run }) };

        // A watch stopped (or restarted) since the claim runs no turn at all.
        if (!(await ctx.runQuery(internal.source_control.pr_watch_wake.isWatchWakeCurrent, identity))) {
            await ctx.runMutation(internal.source_control.pr_watch_wake.finishWatchWake, {
                ...identity,
                delivered: false,
                markers: args.markers,
                reasons: args.reasons,
            });

            return null;
        }

        let delivered = false;

        try {
            await runHeadlessAgent(ctx, {
                memory: false,
                model: args.model,
                organizationId: args.organizationId,
                origin: "trigger",
                personalization: "full",
                prompt: wakePrompt(args, args.reasons),
                thread: { threadId: args.threadId },
                tools: "headless",
                userId: args.userId,
            });
            delivered = true;
        } catch (error) {
            // The turn did not complete: the reasons stay pending and the next poll that still owes them tries again.
            console.warn("[pr-watch-wake] the wake turn failed", { error, linkId: args.linkId });
        }

        await ctx.runMutation(internal.source_control.pr_watch_wake.finishWatchWake, { ...identity, delivered, markers: args.markers, reasons: args.reasons });

        return null;
    });
