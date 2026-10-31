/**
 * The review of a goal's round, as a job on the jobs queue.
 *
 * `runStreamingAgent` (and the approval continuation) queue one when a run that
 * belongs to a goal ends without pausing. The job claims its round first, makes
 * ONE utility-model call over the goal and the round's transcript, records the
 * verdict, and — when the goal goes on — queues the next round's run. Rounds
 * are therefore each a claimed queue job; a redelivery finds the claim taken.
 */
import { v } from "lunorash/server";

import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";
import { internalAction } from "../../_generated/server";
import { enqueueJob } from "../../lib/job-queue";
import { streamLogger } from "../../lib/logger";
import { gatewayFetch } from "../../lib/services";
import { setThreadStatus } from "../lib/agent-run";
import type { GoalVerdict } from "./logic";
import { reviewRound } from "./review";

/**
 * Called when a run that may belong to a goal has ended. Returns whether a goal
 * review was queued — then the goal owns the thread's status and the follow-up
 * suggestions until it ends, and the caller leaves both alone. `run` names the
 * prompt row the run answered (a continuation names its stream, which records it): only
 * the goal whose current round that row opened is handed the run, so a run that ends
 * after its goal was replaced never reviews the new one.
 */
export const handOffToGoalReview = async (
    ctx: Pick<ActionCtx, "runQuery">,
    threadId: string,
    run: { messageId: string } | { streamId: string },
): Promise<boolean> => {
    const goal = await ctx.runQuery(internal.chat.goals.internal.getActiveGoalForRun, {
        ...("messageId" in run ? { messageId: run.messageId } : { streamId: run.streamId as never }),
        threadId: threadId as never,
    });

    if (!goal) {
        return false;
    }

    await enqueueJob(internal.chat.goals.execute.reviewGoalRound, { goalId: goal.goalId, round: goal.round + 1 });

    return true;
};

/**
 * Whether the thread belongs to a goal this run is not part of (its own goal was replaced while it ran). The
 * caller then leaves the thread's status and follow-ups to that goal.
 */
export const otherGoalHoldsThread = async (
    ctx: Pick<ActionCtx, "runQuery">,
    threadId: string,
    run: { messageId: string } | { streamId: string },
): Promise<boolean> =>
    await ctx
        .runQuery(internal.chat.goals.internal.otherGoalHoldsThread, {
            ...("messageId" in run ? { messageId: run.messageId } : { streamId: run.streamId as never }),
            threadId: threadId as never,
        })
        .catch(() => false);

/**
 * Called when a run that may belong to a goal pauses on a tool approval: the goal is waiting on a person,
 * so its stall clock restarts (the sweep would otherwise end it an hour later).
 */
export const noteGoalPaused = async (ctx: Pick<ActionCtx, "runMutation">, threadId: string): Promise<void> => {
    await ctx.runMutation(internal.chat.goals.internal.touchGoal, { threadId: threadId as never }).catch(() => undefined);
};

/** The run the goal opens next, queued after the mutation that wrote it committed. */
const startNextRound = async (
    next: {
        config: Record<string, unknown> & { model: string; origin?: "outside_agent"; skill?: { rawArgs: string; slug: string } };
        messageId: string;
        organizationId?: string;
        streamId: string;
    },
    goal: { threadId: string; userId: string },
): Promise<void> => {
    // `origin` and `skill` are the run's own arguments; the rest is its stream's config.
    const { origin, skill, ...config } = next.config;

    await enqueueJob(internal.chat.execute.runStreamingAgent, {
        isAnonymous: false,
        messageId: next.messageId,
        ...(next.organizationId !== undefined && { organizationId: next.organizationId }),
        // The round keeps what the first run was: an API key's run still has its tool limits.
        ...(origin !== undefined && { origin }),
        ...(skill !== undefined && { skill }),
        streamId: next.streamId,
        streamingConfig: {
            contentType: "text",
            ...config,
            // A goal runs Deep Work.
            shouldAutoContinue: true,
        },
        threadId: goal.threadId,
        userId: goal.userId,
    } as never);
};

export const reviewGoalRound = internalAction
    .input({ goalId: v.id("threadGoals"), round: v.number() })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const goal = await ctx.runMutation(internal.chat.goals.internal.claimGoalRound, args);

        if (!goal) {
            return null;
        }

        const { goalId, round } = args;
        let verdict: GoalVerdict & { costMicrodollars: number };
        let read: { costMicrodollars: number; lastMessage?: { id: string; order: number }; lastOrder?: number; taintedBy?: string[]; transcript: string };

        try {
            read = await ctx.runQuery(internal.chat.goals.internal.roundTranscript, { goalId });
            verdict = await reviewRound({
                gateway: gatewayFetch(ctx),
                goal: goal.text,
                round,
                threadId: goal.threadId,
                transcript: read.transcript,
                userId: goal.userId,
            });
        } catch (error) {
            streamLogger.error(`[Goal] Review of round ${String(round)} failed:`, error);

            // Only a goal this call ended gives the thread back: one the user stopped, or that a new message superseded, is no longer ours to settle.
            if (await ctx.runMutation(internal.chat.goals.internal.failGoalReview, { goalId, reason: "review_failed", round })) {
                await setThreadStatus(ctx, goal.threadId, "active").catch(() => undefined);
            }

            return null;
        }

        const recordVerdict = async () =>
            await ctx.runMutation(internal.chat.goals.internal.recordGoalVerdict, {
                ...(read.lastOrder !== undefined && { anchorOrder: read.lastOrder }),
                costMicrodollars: read.costMicrodollars + verdict.costMicrodollars,
                goalId,
                ...(read.lastMessage && { lastMessage: read.lastMessage }),
                met: verdict.met,
                reason: verdict.reason,
                round,
                ...(read.taintedBy && { taintedBy: read.taintedBy }),
            });
        let outcome: Awaited<ReturnType<typeof recordVerdict>>;

        try {
            outcome = await recordVerdict();
        } catch (error) {
            // The round is claimed, so a redelivery would do nothing: end the goal here instead of leaving the chat running.
            streamLogger.error(`[Goal] The verdict on round ${String(round)} could not be recorded:`, error);

            if (await ctx.runMutation(internal.chat.goals.internal.failGoalReview, { goalId, reason: "error", round })) {
                await setThreadStatus(ctx, goal.threadId, "active").catch(() => undefined);
            }

            return null;
        }

        if (outcome.outcome === "ended") {
            // The goal held the follow-ups back while it ran (`handOffToGoalReview`).
            void ctx.scheduler.runAfter(0, internal.chat.functions.generateFollowupSuggestionsForThread, { threadId: goal.threadId, userId: goal.userId });

            return null;
        }

        if (outcome.outcome === "continue" && outcome.next) {
            try {
                await startNextRound(outcome.next as never, goal);
            } catch (error) {
                // The next round's rows exist but nothing will run them: end the goal and close the stream.
                streamLogger.error(`[Goal] Round ${String(round + 1)} could not be queued:`, error);
                const failed = await ctx.runMutation(internal.chat.goals.internal.failGoalReview, { goalId, reason: "error", round });

                await ctx.runMutation(internal.chat.streaming.persistent.library.setStreamStatus, {
                    status: "error",
                    streamId: outcome.next.streamId as never,
                });

                if (failed) {
                    await setThreadStatus(ctx, goal.threadId, "active").catch(() => undefined);
                }
            }
        }

        return null;
    });
