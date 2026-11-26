/**
 * The wake turn of a pull request watch: what the poller recorded (`pr-watch-poll.ts` keeps the owed reasons in
 * `watchPending`) is delivered to the linked thread as one headless turn. The poller never sends; this does.
 *
 * Delivery is claimed first (`claimWatchWake`, a lease on the link), so two polls that both see the reasons start one turn.
 * The claim refuses when the watch is no longer the one that was polled (run and start), when the cap of wakes is reached or the
 * cooldown has not passed, and when the thread cannot take a run now (locked, deleted, not the owner's, a reply streaming).
 * The wake is COUNTED, and `watchPending` cleared, only by `finishWatchWake` after the turn ran: a failed delivery leaves the
 * reasons pending and the count where it was, so the next poll that still owes them tries again. Only the reasons that were
 * delivered are cleared; one the poller added meanwhile stays.
 *
 * Reads and writes of watch state happen on the owner's shard only (`currentUserShard`, `runAfterOnShard`).
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction, internalMutation } from "../_generated/server";
import { runHeadlessAgent } from "../chat/lib/headless-run";
import { loadEligibleThread } from "../devices/internal";
import { isThreadLocked } from "../lib/thread-lock";
import { PR_WATCH_MAX_WAKES, PR_WATCH_WAKE_COOLDOWN_MS, type WatchWakeReason } from "./pr-watch-logic";

/** How long a claimed delivery holds the link: a turn is one headless run, well inside the scheduler's 15-minute action limit. */
export const PR_WATCH_WAKE_LEASE_MS = 14 * 60 * 1000;

const vReason = v.union(v.literal("checks"), v.literal("conflict"), v.literal("review"));

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

const vClaim = v.object({
    claim: v.number(),
    model: v.string(),
    number: v.number(),
    organizationId: v.union(v.string(), v.null()),
    reasons: v.array(vReason),
    repository: v.string(),
    threadId: v.string(),
    userId: v.string(),
});

const key = { linkId: v.id("pullRequestThreads"), run: v.optional(v.string()), startedAt: v.number() };

/**
 * Takes the delivery of the link's pending reasons, or answers null: the watch is not the polled one, nothing is pending, the cap
 * or the cooldown forbids a wake, another delivery holds the lease, or the thread cannot take a run now.
 */
export const claimWatchWake = internalMutation
    .input(key)
    .output(v.union(v.null(), vClaim))
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

        const thread = await loadEligibleThread(ctx, link.threadId, link.userId);

        // A reply that is streaming holds the thread's run lock: the turn waits, and the reasons stay pending for the next poll.
        const liveReply = thread
            ? await ctx.db.persistentStreams.findFirst({ where: { status: { in: ["pending", "streaming"] }, threadId: thread._id as string } })
            : null;

        if (thread === null || isThreadLocked(thread) || thread.deleted === true || liveReply !== null) {
            return null;
        }

        const claim = ctx.now + PR_WATCH_WAKE_LEASE_MS;

        await ctx.db.patch("pullRequestThreads", link._id, { watchWakeLeaseUntil: claim });

        return {
            claim,
            model: thread.model || DEFAULT_CHAT_MODEL,
            number: link.number,
            organizationId: thread.organizationId ?? null,
            reasons,
            repository: link.repository,
            threadId: String(thread._id),
            userId: link.userId,
        };
    });

/**
 * Ends a delivery. Releases the lease it holds (a lease that is no longer this claim's is left alone). A delivered wake is counted
 * once (`wakes`, `lastWakeAt`) and its reasons leave `watchPending`, only while the same watch still runs; a failed one changes
 * nothing else.
 */
export const finishWatchWake = internalMutation
    .input({ ...key, claim: v.number(), delivered: v.boolean(), reasons: v.array(vReason) })
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

        await ctx.db.patch("pullRequestThreads", link._id, {
            watch: { ...link.watch, lastWakeAt: ctx.now, wakes: (link.watch.wakes ?? 0) + 1 },
            watchPending: (link.watchPending ?? []).filter((reason) => !args.reasons.includes(reason)),
            watchWakeLeaseUntil: 0,
        });

        return null;
    });

/** One delivery: claim, run the turn in the thread, then count it. A turn that fails is released uncounted, for a later try. */
export const deliverWatchWake = internalAction
    .input(key)
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const claimed = await ctx.runMutation(internal.source_control.pr_watch_wake.claimWatchWake, args);

        if (claimed === null) {
            return null;
        }

        let delivered = false;

        try {
            await runHeadlessAgent(ctx, {
                memory: false,
                model: claimed.model,
                organizationId: claimed.organizationId,
                origin: "trigger",
                personalization: "full",
                prompt: wakePrompt(claimed, claimed.reasons),
                thread: { threadId: claimed.threadId },
                tools: "headless",
                userId: claimed.userId,
            });
            delivered = true;
        } catch (error) {
            // The turn did not complete: the reasons stay pending and the next poll that still owes them tries again.
            console.warn("[pr-watch-wake] the wake turn failed", { error, linkId: args.linkId });
        }

        await ctx.runMutation(internal.source_control.pr_watch_wake.finishWatchWake, {
            ...args,
            claim: claimed.claim,
            delivered,
            reasons: claimed.reasons,
        });

        return null;
    });
