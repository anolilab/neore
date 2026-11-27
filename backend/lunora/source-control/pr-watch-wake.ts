/**
 * The wake turn of a pull request watch: what the poller recorded (`pr-watch-poll.ts` keeps the owed reasons in
 * `watchPending`) is delivered to the linked thread as one headless turn. The poller never sends; this does.
 *
 * Three steps, so the long part is off the user's short-job scheduler lane and a consumer never runs ahead of the claim:
 *
 * 1. `claimWatchWake` (a mutation, called by `startWatchWake`) CLAIMS the delivery. It refuses when the watch is no longer the one
 *    that was polled (run and start), the cap of wakes is reached, the cooldown or a failure's retry time has not passed, another
 *    delivery holds the lease, the thread cannot take a run now (locked, deleted or being deleted, a reply streaming) or the account may
 *    not run unattended turns. A refusal changes nothing: the reasons stay pending and the next poll tries again.
 * 2. `startWatchWake` (an action, scheduled by the poller) enqueues the turn on the jobs queue under a claim-once id only AFTER the
 *    claim committed, so a fast consumer always finds its lease. A send that fails releases the claim at once (nothing counted); a send
 *    that succeeds but is never consumed leaves the lease to lapse (`PR_WATCH_WAKE_LEASE_MS`), after which the next poll claims again.
 * 3. `runWatchWake` (the job) asks `beginWatchWake`, right before the turn, whether it may go ahead: the lease is still its own and
 *    in the future, the thread can still take a turn, and a round is CHARGED to the daily limits (as a task or trigger run is,
 *    `tasks/account.ts`) only now, so a job that skips the turn charges nothing and a turn that fails before it reaches the model is
 *    refunded. It then runs the turn, and `finishWatchWake` counts the wake only after the turn ran.
 *
 * A failed turn is not retried at once: the failure is recorded on the link (`watchWakeFailure`), the next claim waits the cooldown
 * (`PR_WATCH_WAKE_COOLDOWN_MS`, the retry spacing), the third failure in a row stops the watch, and an error that trying again cannot
 * cure (`isTerminalWakeError`) stops it at once. A delivery resets the count. Before the turn the job checks the thread again
 * (`beginWatchWake`): a reply that started since the claim, a lock or a delete makes it wait, without counting a failure.
 *
 * A reason is cleared only if no newer occurrence of its kind was recorded while the turn ran: each reason is delivered with the
 * marker of the occurrence it came from (the failing head, the conflicting head, the newest review), and a marker that has moved
 * since means another occurrence is owed, which stays pending for the next delivery.
 *
 * Reads and writes of watch state happen on the owner's shard only (`currentUserShard`, `runAfterOnShard`, `enqueueJob`).
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc } from "../_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx } from "../_generated/server";
import { runHeadlessAgent } from "../chat/lib/headless-run";
import { loadEligibleThread } from "../devices/internal";
import { enqueueJob } from "../lib/job-queue";
import { JOB_LEASE_MS } from "../lib/job-once";
import { isThreadLocked } from "../lib/thread-lock";
import { chargeRound, loadTaskAccount, refundRoundKeys, roundQuotaKeys, taskAccessProblem } from "../tasks/account";
import { heldWakeLeases } from "./pr-watch-wake-lease";
import { PR_WATCH_MAX_WAKES, PR_WATCH_WAKE_COOLDOWN_MS, type WatchWakeReason } from "./pr-watch-logic";

/**
 * How long a claimed delivery holds the link. The turn is a queue job: one invocation is capped at 15 minutes, and the claim-once
 * wrapper (`lib/job-once.ts`) already allows `JOB_LEASE_MS` for a delivery and never starts a second run of the same job, so a
 * live turn cannot outlast that. This is that bound plus five minutes for the queue's own delay before the job starts, so a second
 * delivery can never begin while the first still runs. A job that dies leaves the lease to lapse, and the claim's `onLapse` releases it sooner.
 */
export const PR_WATCH_WAKE_LEASE_MS = JOB_LEASE_MS + 5 * 60 * 1000;

/** Failures of the wake turn in a row after which the watch is stopped. */
export const PR_WATCH_MAX_WAKE_FAILURES = 3;
/** Tries of the settlement alone (never the model) when it fails after the turn ran. */
const FINISH_RETRIES = 2;

/**
 * Whether trying again would fail the same way: a refusal the run raised itself (`AgentRunError`: a plan that does not cover the model,
 * a custom or local endpoint that is missing, an owner who left the organization, a stale approval) or a request the backend refused
 * for a reason that does not pass (`FORBIDDEN`, `NOT_FOUND`, `BAD_REQUEST`). A provider or network error is retryable.
 */
const TERMINAL_CODES: ReadonlySet<string> = new Set(["BAD_REQUEST", "FORBIDDEN", "NOT_FOUND"]);

export const isTerminalWakeError = (error: unknown): boolean =>
    (error instanceof Error && error.name === "AgentRunError") || (error instanceof LunoraError && TERMINAL_CODES.has(error.code));

const vReason = v.union(v.literal("checks"), v.literal("conflict"), v.literal("review"));
const vMarkers = v.object({ checks: v.optional(v.string()), conflict: v.optional(v.string()), review: v.optional(v.string()) });

const vBegin = v.union(
    v.object({ status: v.literal("stale") }),
    v.object({ status: v.literal("wait") }),
    v.object({ charged: v.array(v.string()), status: v.literal("run") }),
);

const vTurn = v.object({
    claim: v.number(),
    linkId: v.id("pullRequestThreads"),
    markers: vMarkers,
    model: v.string(),
    number: v.number(),
    organizationId: v.union(v.string(), v.null()),
    reasons: v.array(vReason),
    repository: v.string(),
    run: v.optional(v.string()),
    startedAt: v.number(),
    threadId: v.string(),
    userId: v.string(),
});

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
 * The thread the turn would run in, or null when it cannot take one now: not the owner's, locked, deleted or being deleted, or with a reply pending or
 * streaming (a chat reply holds the thread's run lock). Read at the claim and again by the job right before the turn.
 */
const wakeableThread = async (ctx: Pick<MutationCtx, "db">, link: Doc<"pullRequestThreads">): Promise<Doc<"threads"> | null> => {
    const thread = await loadEligibleThread(ctx, link.threadId, link.userId);

    if (thread === null || isThreadLocked(thread) || thread.deleted === true || thread.deletingAt !== undefined) {
        return null;
    }

    const liveReply = await ctx.db.persistentStreams.findFirst({ where: { status: { in: ["pending", "streaming"] }, threadId: thread._id as string } });

    return liveReply === null ? thread : null;
};

/**
 * Claims the delivery of the link's pending reasons and answers the turn to run, or null and nothing is changed: the watch is not the
 * polled one, nothing is pending, the cap, the cooldown or a failure's retry time forbids a wake, another delivery holds the lease, the
 * thread cannot take a run now, or the account may not run unattended turns. Nothing is charged here.
 */
export const claimWatchWake = internalMutation
    .input(key)
    .output(v.union(v.null(), vTurn))
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
            return null;
        }

        const reasons = link.watchPending ?? [];

        if (reasons.length === 0 || (link.watch.wakes ?? 0) >= PR_WATCH_MAX_WAKES) {
            return null;
        }

        if (link.watch.lastWakeAt !== undefined && ctx.now - link.watch.lastWakeAt < PR_WATCH_WAKE_COOLDOWN_MS) {
            return null;
        }

        if (link.watchWakeLeaseUntil !== undefined && ctx.now < link.watchWakeLeaseUntil) {
            return null;
        }

        // A failed turn waits out its retry time: the poll that finds the reasons still pending does not start another at once.
        if (link.watchWakeFailure !== undefined && ctx.now < link.watchWakeFailure.retryAt) {
            return null;
        }

        const thread = await wakeableThread(ctx, link);

        if (thread === null) {
            return null;
        }

        // Another watch's turn is running in this thread (a thread can link several pull requests): no replacement claim beside it.
        const running = await heldWakeLeases(ctx, link.userId, link.threadId, ctx.now, link._id);

        if (running.length > 0) {
            return null;
        }

        // An unattended turn answers to the same limits as a task or trigger run: the account must be allowed to run them. The round is
        // charged by the job, right before the model is asked (`beginWatchWake`).
        if (taskAccessProblem(await loadTaskAccount(ctx, link.userId)) !== undefined) {
            return null;
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

        return turn;
    });

/**
 * The scheduled step: claims the delivery, then (after the claim committed) enqueues the turn on the jobs queue under a claim-once id,
 * so a redelivery never runs a second paid turn and a job that dies frees the lease (`releaseWatchWake`). A send that fails releases
 * the claim at once, counting nothing, so no claim stays held with no job behind it.
 */
export const startWatchWake = internalAction
    .input(key)
    .output(v.boolean())
    .action(async ({ args, ctx }) => {
        const turn = await ctx.runMutation(internal.source_control.pr_watch_wake.claimWatchWake, args);

        if (turn === null) {
            return false;
        }

        try {
            await enqueueJob(internal.source_control.pr_watch_wake.runWatchWake, turn, {
                once: {
                    jobId: `pr-watch-wake:${String(turn.linkId)}:${String(turn.claim)}`,
                    onLapse: {
                        args: { claim: turn.claim, linkId: turn.linkId, startedAt: turn.startedAt, ...(turn.run !== undefined && { run: turn.run }) },
                        ref: internal.source_control.pr_watch_wake.releaseWatchWake,
                    },
                    userId: turn.userId,
                },
                shardKey: turn.userId,
            });
        } catch (error) {
            console.warn("[pr-watch-wake] the wake turn could not be enqueued", { error, linkId: turn.linkId });
            await ctx.runMutation(internal.source_control.pr_watch_wake.releaseWatchWake, {
                claim: turn.claim,
                linkId: turn.linkId,
                startedAt: turn.startedAt,
                ...(turn.run !== undefined && { run: turn.run }),
            });

            return false;
        }

        return true;
    });

/**
 * Run by the job right before the turn: whether it may go ahead, and the round is charged here, only when it does. `run` when the
 * delivery still holds the lease on the same watch, the lease is still in the future (an older job must not start beside a newer claim),
 * the thread can take a turn, and the daily limits had room for the round (now charged); `stale` when the watch was stopped or
 * restarted or the lease ended (this claim's lease is freed, a newer claim's is left alone); `wait` when a reply started, the thread was
 * locked, deleted or being deleted, or a daily limit is spent (the lease is freed and the next claim waits the retry spacing, with no
 * failure counted: nothing went wrong). Check and turn are two steps, so a reply that starts in between is not seen: the thread has no
 * shared run reservation a headless run takes, only the stream rows read here.
 */
export const beginWatchWake = internalMutation
    .input({ ...key, claim: v.number() })
    .output(vBegin)
    .mutation(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        // Not this claim's lease (a newer claim replaced it): leave it alone, it is not ours to free.
        if (link === null || link.watchWakeLeaseUntil !== args.claim) {
            return { status: "stale" as const };
        }

        const same =
            link.watchActive === true &&
            link.watch !== undefined &&
            link.watch.stoppedAt === undefined &&
            link.watch.startedAt === args.startedAt &&
            link.watchRun === args.run;

        if (!same || ctx.now >= args.claim) {
            await ctx.db.patch("pullRequestThreads", link._id, { watchWakeLeaseUntil: 0 });

            return { status: "stale" as const };
        }

        const waits = async () => {
            await ctx.db.patch("pullRequestThreads", link._id, {
                watchWakeFailure: {
                    at: ctx.now,
                    attempts: link.watchWakeFailure?.attempts ?? 0,
                    kind: "retryable",
                    retryAt: ctx.now + PR_WATCH_WAKE_COOLDOWN_MS,
                },
                watchWakeLeaseUntil: 0,
            });

            return { status: "wait" as const };
        };

        if ((await wakeableThread(ctx, link)) === null) {
            return await waits();
        }

        // The round is charged to the daily limits only now, right before the model is asked: a job that skips the turn above charged nothing.
        const account = await loadTaskAccount(ctx, link.userId);

        if (taskAccessProblem(account) !== undefined || account === null || !(await chargeRound(ctx, link.userId, account))) {
            return await waits();
        }

        // The exact limits this round was charged to, handed to the job so a refund gives back those and not whatever the plan maps to later.
        return { charged: roundQuotaKeys(account), status: "run" as const };
    });

/**
 * Gives the round back for a turn that failed before it reached the model (never one that made a model call): one unit to each limit
 * the charge took, as `beginWatchWake` reported them.
 */
export const refundWatchWakeRound = internalMutation
    .input({ charged: v.array(v.string()), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await refundRoundKeys(ctx, args.userId, args.charged);

        return null;
    });

/**
 * Ends a delivery. Releases the lease it holds (a lease that is no longer this claim's is left alone). A delivered wake is counted
 * once (`wakes`, `lastWakeAt`) and its reasons leave `watchPending`, only while the same watch still runs, and only a reason whose
 * occurrence is the one delivered (`markers`): one recorded again while the turn ran stays pending. A failed one changes nothing else.
 */
export const finishWatchWake = internalMutation
    .input({ ...key, claim: v.number(), delivered: v.boolean(), markers: vMarkers, reasons: v.array(vReason), terminal: v.optional(v.boolean()) })
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

        if (!same || link.watch === undefined) {
            await ctx.db.patch("pullRequestThreads", link._id, { watchWakeLeaseUntil: 0 });

            return null;
        }

        if (!args.delivered) {
            // The turn failed: counted, spaced by the cooldown, and the watch stopped at the third in a row or at a terminal error.
            const attempts = (link.watchWakeFailure?.attempts ?? 0) + 1;
            const terminal = args.terminal === true;
            const ended = terminal || attempts >= PR_WATCH_MAX_WAKE_FAILURES;

            await ctx.db.patch("pullRequestThreads", link._id, {
                watchWakeFailure: { at: ctx.now, attempts, kind: terminal ? "terminal" : "retryable", retryAt: ctx.now + PR_WATCH_WAKE_COOLDOWN_MS },
                watchWakeLeaseUntil: 0,
                ...(ended && { watch: { ...link.watch, stoppedAt: ctx.now }, watchActive: false }),
            });

            if (ended) {
                ctx.log.event("develop.watch_ended", {
                    attempt: attempts,
                    linkId: String(link._id),
                    reason: terminal ? "wake_failed_terminal" : "wake_failed",
                });
            }

            return null;
        }

        const { watch } = link;

        await ctx.db.patch("pullRequestThreads", link._id, {
            watch: { ...watch, lastWakeAt: ctx.now, wakes: (watch.wakes ?? 0) + 1 },
            watchPending: (link.watchPending ?? []).filter((reason) => !args.reasons.includes(reason) || currentMarker(watch, reason) !== args.markers[reason]),
            watchWakeLeaseUntil: 0,
            // A delivery ends the run of failures (the last one stays as history).
            ...(link.watchWakeFailure !== undefined && { watchWakeFailure: { ...link.watchWakeFailure, attempts: 0, retryAt: 0 } }),
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
        // Added by the claim-once wrapper (`lib/job-once.ts`) when it invokes the job: an action takes only the arguments it declares.
        jobId: v.optional(v.string()),
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

        // Checked again right before the turn: a watch stopped since the claim, a reply that started, a lock or a delete.
        const may = await ctx.runMutation(internal.source_control.pr_watch_wake.beginWatchWake, identity);

        if (may.status !== "run") {
            return null;
        }

        const { charged } = may;

        let delivered = false;
        let terminal = false;
        // From the first generation on, a failure may have been billed; before it, the round is given back.
        let reachedModel = false;

        try {
            await runHeadlessAgent(ctx, {
                memory: false,
                model: args.model,
                onGenerationStart: () => {
                    reachedModel = true;
                },
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
            // The turn did not complete: the reasons stay pending, and the failure is recorded so a retry waits and the streak is bounded.
            terminal = isTerminalWakeError(error);

            if (!reachedModel) {
                await ctx
                    .runMutation(internal.source_control.pr_watch_wake.refundWatchWakeRound, { charged, userId: args.userId })
                    .catch((refundError: unknown) => {
                        console.warn("[pr-watch-wake] could not give the round back", { linkId: args.linkId, refundError });
                    });
            }

            console.warn("[pr-watch-wake] the wake turn failed", { error, linkId: args.linkId, terminal });
        }

        // The turn is over and paid for: only this settlement is tried again, never the turn. The queue does not redeliver the job either
        // (the claim-once wrapper completes its claim when the job ends, even by a throw), so a settlement that keeps failing leaves the
        // lease to lapse rather than running the model a second time for the same occurrence.
        for (let attempt = 0; ; attempt += 1) {
            try {
                await ctx.runMutation(internal.source_control.pr_watch_wake.finishWatchWake, {
                    ...identity,
                    delivered,
                    markers: args.markers,
                    reasons: args.reasons,
                    ...(terminal && { terminal }),
                });

                return null;
            } catch (error) {
                if (attempt >= FINISH_RETRIES) {
                    throw error;
                }
            }
        }
    });
