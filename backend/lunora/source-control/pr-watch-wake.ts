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
import { MODEL_LOOKUP } from "@neore/ai/models";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { type ActionCtx, internalAction, internalMutation, type MutationCtx } from "../_generated/server";
import { runHeadlessAgent } from "../chat/lib/headless-run";
import { enqueueJob } from "../lib/job-queue";
import { JOB_LEASE_MS } from "../lib/job-once";
import { threadHasLiveGrant } from "../agent/live-grant";
import { isDeviceEligibleThread } from "../devices/internal";
import { isThreadLocked } from "../lib/thread-lock";
import { chargeRound, loadTaskAccount, refundRoundKeys, roundQuotaKeys, roundWindowEnds, taskAccessProblem } from "../tasks/account";
import { wakeLeaseHeld } from "./pr-watch-wake-lease";
import { isTaskModelAllowed } from "../tasks/logic";
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

/**
 * The only tools a wake turn gets: the two pull request reads. The turn reads text anyone can write on the pull request (titles,
 * comments, check output) with nobody present, so it must not be able to write anything: no reply, re-run, merge or unwatch, no other
 * tool that changes the host or the owner's data, and none of the owner's connector or MCP tools. Enforced where the headless run builds its
 * tools (`toolAllowlist`, applied before the model is given any), not only in the prompt.
 */
export const WAKE_TOOL_ALLOWLIST: ReadonlyArray<string> = ["readFailingChecks", "readPullRequest"];

const vReason = v.union(v.literal("checks"), v.literal("conflict"), v.literal("review"));
const vMarkers = v.object({ checks: v.optional(v.string()), conflict: v.optional(v.string()), review: v.optional(v.string()) });

const vBegin = v.union(
    v.object({ status: v.literal("stale") }),
    v.object({ status: v.literal("wait") }),
    v.object({ charged: v.array(v.string()), model: v.string(), status: v.literal("run") }),
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
    // The owner's own thread, not locked, not deleted or being deleted. Sharing is decided where a watch starts (`pr-watch.ts`).
    const thread = await ctx.db.get("threads", link.threadId);

    if (thread === null || thread.userId !== link.userId || isThreadLocked(thread) || thread.deleted === true || thread.deletingAt !== undefined) {
        return null;
    }

    const liveReply = await ctx.db.persistentStreams.findFirst({ where: { status: { in: ["pending", "streaming"] }, threadId: thread._id as string } });

    return liveReply === null ? thread : null;
};

/**
 * Whether the chat is still the owner's alone: not shared, public, a group or an external conversation (the rule a watch is started
 * under, `pr-watch.ts`). A chat that stopped being so since the watch started must not be sent pull request details others could not
 * see then, so the turn waits. The pause is noted once on the link (`watchWakeFailure` of kind `shared`, no failure counted, no retry
 * delay), touches neither the cooldown nor the cap, and ends by itself when the chat is the owner's alone again.
 */
const pausedForSharing = async (ctx: Pick<MutationCtx, "db" | "now">, link: Doc<"pullRequestThreads">): Promise<boolean> => {
    const thread = await ctx.db.get("threads", link.threadId);
    const ownerOnly = isDeviceEligibleThread(thread, link.userId, thread !== null && (await threadHasLiveGrant(ctx, link.threadId)));

    if (ownerOnly) {
        return false;
    }

    if (link.watchWakeFailure?.kind !== "shared") {
        await ctx.db.patch("pullRequestThreads", link._id, {
            watchWakeFailure: { at: ctx.now, attempts: link.watchWakeFailure?.attempts ?? 0, kind: "shared", retryAt: 0 },
        });
    }

    return true;
};

type Completed = NonNullable<Doc<"pullRequestThreads">["watchWakeCompleted"]>;

/**
 * The link's fields after a delivered turn is settled: the wake counted once, the delivered reasons cleared (only those whose
 * occurrence marker is unchanged since the claim), the lease released, the failure streak reset and the occurrence marked done.
 */
const settledPatch = (link: Doc<"pullRequestThreads">, watch: NonNullable<Doc<"pullRequestThreads">["watch"]>, record: Completed, now: number) => {
    return {
        watch: { ...watch, lastWakeAt: now, wakes: (watch.wakes ?? 0) + 1 },
        watchPending: (link.watchPending ?? []).filter((reason) => !record.reasons.includes(reason) || currentMarker(watch, reason) !== record.markers[reason]),
        watchWakeCompleted: { ...record, done: true, state: "completed" as const },
        watchWakeLeaseUntil: 0,
        // A delivery ends the run of failures (the last one stays as history).
        ...(link.watchWakeFailure !== undefined && {
            watchWakeFailure: {
                ...link.watchWakeFailure,
                attempts: 0,
                kind:
                    link.watchWakeFailure.kind === "shared" || link.watchWakeFailure.kind === "unavailable"
                        ? ("retryable" as const)
                        : link.watchWakeFailure.kind,
                retryAt: 0,
            },
        }),
    };
};

/**
 * The link's fields after a failed turn: the failure counted and spaced by the cooldown, the watch stopped at the third in a row or at a
 * terminal error, and the occurrence (when there is one) marked done. `ended` says the watch was stopped.
 */
const failedPatch = (link: Doc<"pullRequestThreads">, now: number, terminal: boolean, record: Completed | undefined) => {
    const attempts = (link.watchWakeFailure?.attempts ?? 0) + 1;
    const ended = terminal || attempts >= PR_WATCH_MAX_WAKE_FAILURES;

    return {
        ended,
        patch: {
            watchWakeFailure: { at: now, attempts, kind: terminal ? ("terminal" as const) : ("retryable" as const), retryAt: now + PR_WATCH_WAKE_COOLDOWN_MS },
            watchWakeLeaseUntil: 0,
            ...(record !== undefined && { watchWakeCompleted: { ...record, done: true } }),
            ...(ended && link.watch !== undefined && { watch: { ...link.watch, stoppedAt: now }, watchActive: false }),
        },
    };
};

/** Pays the refund owed on the link, once (the obligation is marked applied), and only for limits whose charged window has not ended. */
const payOwedRefund = async (ctx: MutationCtx, link: Doc<"pullRequestThreads">, claim?: number): Promise<void> => {
    const owed = link.watchWakeRefund;

    // With a claim named, only the refund that claim's charge owes is paid; with none, it is the recovery of an earlier one (`beginWatchWake`).
    if (owed === undefined || owed.applied || (claim !== undefined && owed.claim !== claim)) {
        return;
    }

    await refundRoundKeys(ctx, link.userId, owed.keys, owed.windowEnds, ctx.now);
    await ctx.db.patch("pullRequestThreads", link._id, { watchWakeRefund: { ...owed, applied: true } });
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

        if (link.watchWakeLeaseUntil !== undefined && ctx.now < link.watchWakeLeaseUntil) {
            return null;
        }

        // An occurrence that is not settled never generates again: one occurrence costs at most one model call.
        const record = link.watchWakeCompleted;

        if (record !== undefined && !record.done) {
            // Another run's (the watch was restarted since): discarded, the count and the pending reasons stay as they are.
            if (record.startedAt !== link.watch.startedAt || record.run !== link.watchRun) {
                await ctx.db.patch("pullRequestThreads", link._id, { watchWakeCompleted: { ...record, done: true } });
            } else if (record.state === "completed") {
                // Ran to its end, settlement never landed: settled now, counted once.
                await ctx.db.patch("pullRequestThreads", link._id, settledPatch(link, link.watch, record, ctx.now));

                return null;
            } else {
                // Started and never recorded as ended (the job died, or the completion write kept failing): settled as a failed attempt, and
                // the owner sees it on `watchWakeFailure`. A wake may be lost; a second paid turn for it is not run.
                await payOwedRefund(ctx, link);

                const failed = failedPatch(link, ctx.now, false, record);

                await ctx.db.patch("pullRequestThreads", link._id, failed.patch);

                if (failed.ended) {
                    ctx.log.event("develop.watch_ended", { attempt: failed.patch.watchWakeFailure.attempts, linkId: String(link._id), reason: "wake_failed" });
                }

                return null;
            }
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

        if (thread === null || (await pausedForSharing(ctx, link))) {
            return null;
        }

        // Another watch's turn is running in this thread (a thread can link several pull requests): no replacement claim beside it.
        if (await wakeLeaseHeld(ctx, link.userId, link.threadId, ctx.now, link._id)) {
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
    .input({ ...key, claim: v.number(), markers: vMarkers, reasons: v.array(vReason) })
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

        // Shared, public, group or external since the watch started: nothing is delivered. The lease is released and nothing is counted.
        if (await pausedForSharing(ctx, link)) {
            await ctx.db.patch("pullRequestThreads", link._id, { watchWakeLeaseUntil: 0 });

            return { status: "wait" as const };
        }

        // The model is the chat's own NOW, as for a new turn there (the claim's copy may be stale: the owner can have changed it). One that
        // is no longer available is refused like any other ineligible state: nothing is charged or counted, the lease is released, and the
        // owner sees it once on `watchWakeFailure`.
        const wakeThread = await ctx.db.get("threads", link.threadId);
        // A switched chat runs on the agent it was switched to (`threads.activeAgent`, the cache of the active path's agent), as a normal turn
        // there does; otherwise the chat's own model.
        const model = wakeThread?.activeAgent?.model || wakeThread?.model || DEFAULT_CHAT_MODEL;

        if (!isTaskModelAllowed(model, (id) => MODEL_LOOKUP.get(id))) {
            if (link.watchWakeFailure?.kind !== "unavailable") {
                await ctx.db.patch("pullRequestThreads", link._id, {
                    watchWakeFailure: { at: ctx.now, attempts: link.watchWakeFailure?.attempts ?? 0, kind: "unavailable", retryAt: 0 },
                });
            }

            await ctx.db.patch("pullRequestThreads", link._id, { watchWakeLeaseUntil: 0 });

            return { status: "wait" as const };
        }

        // A refund owed for an earlier turn that failed before the model is paid first, so a new charge never stacks on an unreconciled one.
        await payOwedRefund(ctx, link);

        // The round is charged to the daily limits only now, right before the model is asked: a job that skips the turn above charged nothing.
        const account = await loadTaskAccount(ctx, link.userId);

        if (taskAccessProblem(account) !== undefined || account === null || !(await chargeRound(ctx, link.userId, account))) {
            return await waits();
        }

        // The exact limits this round was charged to, and when their windows end, are written in THIS transaction, with the occurrence about
        // to start: a job that dies after the charge and before the model leaves the refund owed, and a claim that finds the occurrence
        // started never generates again. The job gets the keys for its own refund path.
        const charged = roundQuotaKeys(account);
        const windowEnds = await roundWindowEnds(ctx, link.userId, charged);

        await ctx.db.patch("pullRequestThreads", link._id, {
            watchWakeCompleted: {
                claim: args.claim,
                done: false,
                markers: args.markers,
                reasons: args.reasons,
                startedAt: args.startedAt,
                state: "running",
                ...(args.run !== undefined && { run: args.run }),
            },
            watchWakeRefund: { applied: false, claim: args.claim, keys: charged, windowEnds },
        });

        return { charged, model, status: "run" as const };
    });

/**
 * Called by the run right before it asks the model (`onGenerationStart`): the last check, in the SAME transaction that keeps the charge.
 * The turn goes ahead (`kept`) only if its lease is still its own, the watch is the one polled, and the chat can still take it: the
 * owner's, not locked, deleted or being deleted, no reply streaming, and still the owner's alone. Otherwise (`refused`) the model is not
 * asked: the round is refunded here, the occurrence is closed, the lease is released, the reasons stay pending and no failure is counted
 * (a sharing pause is noted once, as at the claim). A chat changed after this transaction and before the provider has the request is not
 * seen: no shared run reservation exists for a headless run to take, so that window is a stated residual.
 */
export const keepWatchWakeCharge = internalMutation
    .input({ claim: v.number(), linkId: v.id("pullRequestThreads") })
    .output(v.union(v.literal("kept"), v.literal("refused")))
    .mutation(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (link === null || link.watchWakeLeaseUntil !== args.claim) {
            return "refused" as const;
        }

        const record = link.watchWakeCompleted?.claim === args.claim ? link.watchWakeCompleted : undefined;
        const stillRuns =
            link.watchActive === true &&
            link.watch !== undefined &&
            link.watch.stoppedAt === undefined &&
            ctx.now < args.claim &&
            (await wakeableThread(ctx, link)) !== null &&
            !(await pausedForSharing(ctx, link));

        if (!stillRuns) {
            await payOwedRefund(ctx, link);
            await ctx.db.patch("pullRequestThreads", link._id, {
                watchWakeLeaseUntil: 0,
                ...(record !== undefined && { watchWakeCompleted: { ...record, done: true } }),
            });

            return "refused" as const;
        }

        if (link.watchWakeRefund !== undefined && link.watchWakeRefund.claim === args.claim && !link.watchWakeRefund.applied) {
            await ctx.db.patch("pullRequestThreads", link._id, { watchWakeRefund: { ...link.watchWakeRefund, applied: true } });
        }

        return "kept" as const;
    });

/** Pays the refund owed on the link, once: the limits it names get one unit back each (while their window is current), then it is marked applied. */
export const applyWatchWakeRefund = internalMutation
    .input({ claim: v.number(), linkId: v.id("pullRequestThreads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (link !== null) {
            await payOwedRefund(ctx, link, args.claim);
        }

        return null;
    });

/** Records that the turn ran to its end, before its settlement is tried: a later claim then settles it instead of generating again. */
export const completeWatchWake = internalMutation
    .input({ ...key, claim: v.number(), markers: vMarkers, reasons: v.array(vReason) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (link?.watchWakeCompleted !== undefined && link.watchWakeCompleted.claim === args.claim && !link.watchWakeCompleted.done) {
            await ctx.db.patch("pullRequestThreads", link._id, { watchWakeCompleted: { ...link.watchWakeCompleted, state: "completed" } });
        }

        return null;
    });

/**
 * Ends a delivery. Releases the lease it holds (a lease that is no longer this claim's is left alone) and marks the occurrence done.
 * A delivered wake is counted once (`wakes`, `lastWakeAt`) against the run it started under, even if that watch was stopped during the
 * turn, and never against a restarted run; its reasons leave `watchPending`, and only a reason whose occurrence is the one delivered
 * (`markers`) does: one recorded again while the turn ran stays pending. A failed turn is recorded on `watchWakeFailure` while the watch
 * still runs; otherwise it changes nothing else.
 */
export const finishWatchWake = internalMutation
    .input({ ...key, claim: v.number(), delivered: v.boolean(), markers: vMarkers, reasons: v.array(vReason), terminal: v.optional(v.boolean()) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (link === null || link.watchWakeLeaseUntil !== args.claim) {
            return null;
        }

        const record = link.watchWakeCompleted?.claim === args.claim ? link.watchWakeCompleted : undefined;
        const release = { watchWakeLeaseUntil: 0, ...(record !== undefined && { watchWakeCompleted: { ...record, done: true } }) };
        const { watch } = link;
        // The run the turn started under: another run (the watch was restarted) is never counted against or failed.
        const sameRun = watch !== undefined && watch.startedAt === args.startedAt && link.watchRun === args.run;

        if (!sameRun) {
            await ctx.db.patch("pullRequestThreads", link._id, release);

            return null;
        }

        const running = link.watchActive === true && watch.stoppedAt === undefined;

        if (!args.delivered) {
            if (!running) {
                await ctx.db.patch("pullRequestThreads", link._id, release);

                return null;
            }

            // The refund this claim's charge owes (the turn failed before the model) is paid BEFORE the failure can stop the watch.
            await payOwedRefund(ctx, link, args.claim);

            // The turn failed: counted, spaced by the cooldown, and the watch stopped at the third in a row or at a terminal error.
            const terminal = args.terminal === true;
            const failed = failedPatch(link, ctx.now, terminal, record);

            await ctx.db.patch("pullRequestThreads", link._id, failed.patch);

            if (failed.ended) {
                ctx.log.event("develop.watch_ended", {
                    attempt: failed.patch.watchWakeFailure.attempts,
                    linkId: String(link._id),
                    reason: terminal ? "wake_failed_terminal" : "wake_failed",
                });
            }

            return null;
        }

        // A thread that is gone or being deleted has nothing to wake: the lease is released and nothing more is written.
        const thread = await ctx.db.get("threads", link.threadId);

        if (thread === null || thread.deleted === true || thread.deletingAt !== undefined) {
            await ctx.db.patch("pullRequestThreads", link._id, release);

            return null;
        }

        await ctx.db.patch(
            "pullRequestThreads",
            link._id,
            settledPatch(
                link,
                watch,
                record ?? {
                    claim: args.claim,
                    done: false,
                    markers: args.markers,
                    reasons: args.reasons,
                    startedAt: args.startedAt,
                    state: "completed",
                    ...(args.run !== undefined && { run: args.run }),
                },
                ctx.now,
            ),
        );

        return null;
    });

/** Frees the lease of a delivery whose job died (the claim-once lapse handler): nothing is counted, the reasons stay pending. */
export const releaseWatchWake = internalMutation
    .input({ ...key, claim: v.number(), claimKey: v.optional(v.string()) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (link !== null && link.watchWakeLeaseUntil === args.claim) {
            // A job that died after the charge and before the model leaves the refund owed: paid here, once, before the lease is released.
            if (link.watchWakeRefund?.claim === args.claim) {
                await payOwedRefund(ctx, link);
            }

            await ctx.db.patch("pullRequestThreads", link._id, { watchWakeLeaseUntil: 0 });
        }

        return null;
    });

/** Runs a settlement step, trying again a few times: it is only ever a write, never the model. The last error stands. */
const retried = async (step: () => Promise<void>): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
        try {
            await step();

            return;
        } catch (error) {
            if (attempt >= FINISH_RETRIES) {
                throw error;
            }
        }
    }
};

/**
 * A round owed back for a turn that failed before the model: the obligation was written with the charge, so only the payment is tried
 * here, again if it fails. A payment that never lands stays owed, and the lapse handler or the next charge pays it, so it is refunded once.
 */
const owedRefund = async (ctx: Pick<ActionCtx, "runMutation">, linkId: Id<"pullRequestThreads">, claim: number): Promise<void> => {
    try {
        await retried(async () => {
            await ctx.runMutation(internal.source_control.pr_watch_wake.applyWatchWakeRefund, { claim, linkId });
        });
    } catch (error) {
        console.warn("[pr-watch-wake] could not give the round back", { error, linkId });
    }
};

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
        const may = await ctx.runMutation(internal.source_control.pr_watch_wake.beginWatchWake, { ...identity, markers: args.markers, reasons: args.reasons });

        if (may.status !== "run") {
            return null;
        }

        let delivered = false;
        let terminal = false;
        // From the first generation on, a failure may have been billed; before it, the round is given back.
        let reachedModel = false;
        let refused = false;

        try {
            await runHeadlessAgent(ctx, {
                memory: false,
                model: may.model,
                // Recorded before the first generation: the round then stays charged, and a failure from here on is never refunded.
                onGenerationStart: async () => {
                    const kept = await ctx.runMutation(internal.source_control.pr_watch_wake.keepWatchWakeCharge, { claim: args.claim, linkId: args.linkId });

                    // The chat changed since the job's first check: the model is not asked (the run stops here), and nothing is counted.
                    if (kept === "refused") {
                        refused = true;

                        throw new Error("The chat can no longer take the wake");
                    }

                    reachedModel = true;
                },
                organizationId: args.organizationId,
                origin: "trigger",
                personalization: "full",
                prompt: wakePrompt(args, args.reasons),
                thread: { threadId: args.threadId },
                toolAllowlist: WAKE_TOOL_ALLOWLIST,
                tools: "headless",
                userId: args.userId,
            });
            delivered = true;
        } catch (error) {
            // The turn did not complete: the reasons stay pending, and the failure is recorded so a retry waits and the streak is bounded.
            terminal = isTerminalWakeError(error);

            if (!reachedModel) {
                await owedRefund(ctx, args.linkId, args.claim);
            }

            console.warn("[pr-watch-wake] the wake turn failed", { error, linkId: args.linkId, terminal });
        }

        // Refused at the last check: already refunded and released by it, no failure counted and nothing settled.
        if (refused) {
            return null;
        }

        // A turn that ran to its end is recorded durably BEFORE its settlement is tried, so a settlement that keeps failing is settled by a
        // later claim and the model is never asked again for the same occurrence.
        if (delivered) {
            await retried(async () => {
                await ctx.runMutation(internal.source_control.pr_watch_wake.completeWatchWake, { ...identity, markers: args.markers, reasons: args.reasons });
            });
        }

        // The turn is over and paid for: only this settlement is tried again, never the turn. The queue does not redeliver the job either
        // (the claim-once wrapper completes its claim when the job ends, even by a throw), so a settlement that keeps failing leaves the
        // lease to lapse rather than running the model a second time for the same occurrence.
        await retried(async () => {
            await ctx.runMutation(internal.source_control.pr_watch_wake.finishWatchWake, {
                ...identity,
                delivered,
                markers: args.markers,
                reasons: args.reasons,
                ...(terminal && { terminal }),
            });
        });

        return null;
    });
