/**
 * A goal's state machine. One `threadGoals` row per goal; the writes that move
 * it are all here, each idempotent, because the review runs on the jobs queue
 * (at least once):
 *
 * - `startGoal` opens a goal and, in the same transaction, ends the thread's previous one: a later
 *   start can never be ended by an earlier one's stream, which is created afterwards.
 * - `closeStaleGoalRound` is the check a goal's next round makes before it runs: a round whose goal
 *   ended in between (a new message, Stop) closes its stream instead of running beside the user's turn.
 * - `claimGoalRound` is the claim a review takes before it spends a model call,
 *   like `claimStreamRun` for a stream: round N is claimed by one delivery only.
 * - `recordGoalVerdict` applies the verdict. When the goal goes on, the next
 *   round's instruction, its stream and its charge are written in THIS mutation,
 *   so a Stop (or a redelivery) cannot fall between them. Only after it commits
 *   does the caller queue the run.
 * - `endActiveGoals` is the one way a goal is ended from outside (Stop, a new
 *   message, a failed run).
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { internalMutation, internalQuery } from "../../_generated/server";
import { candidatesOnActivePath } from "../../agent/branch-rows";
import { isThreadLocked } from "../../lib/thread-lock";
import { addMessagesHandler } from "../../agent/messages";
import { patchThread } from "../../agent/table-writes";
import { computeTaint } from "../../devices/lib/taint";
import { sumMessageCosts } from "../../agent/message-cost";
import { isAccountDeletionUnderway } from "../../gdpr/deletion-guard";
import { withoutUndefined } from "../../lib/patch";
import { MAX_LENGTH } from "../../lib/validators";
import { chargeRound, loadTaskAccount, taskAccessProblem } from "../../tasks/account";
import { insertPersistentStream } from "../streaming/persistent/library";
import {
    buildGoalContinuationPrompt,
    buildGoalTranscript,
    clampGoalRounds,
    decideGoalRound,
    GOAL_MAX_COST_MICRODOLLARS,
    GOAL_TEXT_MAX,
    type GoalStopReason,
} from "./logic";
import { activeGoalsOf, endActiveGoals, giveThreadBack, hasLiveStream, stopGoalRow } from "./rows";
import { GOAL_CONTINUATION_AGENT } from "./shared";
import { vGoalRunConfig, vGoalStopReason } from "./validators";

/** How far back from the thread's end a round's rows are looked for. A round is at most a few dozen steps. */
const ROUND_ROWS_SCAN = 200;

const ANONYMOUS_GOALS_MESSAGE = "Goals need an account. Sign up to run until a goal is met.";

/** The prompt row a run answers: named directly, or read off the run's stream. */
const runPromptId = async (ctx: Pick<QueryCtx, "db">, run: { messageId?: string; streamId?: Id<"persistentStreams"> }): Promise<string | undefined> => {
    if (run.messageId !== undefined || run.streamId === undefined) {
        return run.messageId;
    }

    const stream = await ctx.db.get(run.streamId);

    if (!stream) {
        return undefined;
    }

    // An approval continuation's stream is keyed on the approval id; the paused run's prompt is in its snapshot.
    const approval = await ctx.db
        .query("toolApprovalRuns")
        .withIndex("by_approvalId", (q) => q.eq("approvalId", stream.messageId))
        .first();

    return approval?.config.promptMessageId ?? stream.messageId;
};

/**
 * Ends the thread's active goals. Given a run (`streamId`), only the goal whose current round that run answers:
 * a run that fails after its goal was replaced must not stop the replacement.
 */
export const endGoalsForThread = internalMutation
    .input({ reason: vGoalStopReason, streamId: v.optional(v.id("persistentStreams")), threadId: v.id("threads") })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        if (args.streamId === undefined) {
            return await endActiveGoals(ctx, args.threadId, args.reason);
        }

        const promptId = await runPromptId(ctx, { streamId: args.streamId });
        const goals = await activeGoalsOf(ctx, args.threadId);
        const own = goals.filter((goal) => promptId !== undefined && goal.promptMessageId === promptId);

        for (const goal of own) {
            await stopGoalRow(ctx, goal, args.reason);
        }

        return own.length > 0;
    });

/**
 * Whether an active goal other than the run's own holds the thread. Such a goal owns the thread's status and
 * follow-ups, so a run that ends after its own goal was replaced leaves both alone.
 */
export const otherGoalHoldsThread = internalQuery
    .input({ messageId: v.optional(v.string().max(MAX_LENGTH.id)), streamId: v.optional(v.id("persistentStreams")), threadId: v.id("threads") })
    .output(v.boolean())
    .query(async ({ args, ctx }) => {
        const promptId = await runPromptId(ctx, args);

        const goals = await activeGoalsOf(ctx, args.threadId);

        return goals.some((goal) => goal.promptMessageId !== promptId);
    });

export const startGoal = internalMutation
    .input({
        config: vGoalRunConfig,
        maxRounds: v.optional(v.number()),
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        promptMessageId: v.string().max(MAX_LENGTH.id),
        text: v.string().max(GOAL_TEXT_MAX),
        threadId: v.id("threads"),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.union(v.object({ goalId: v.id("threadGoals"), ok: v.literal(true) }), v.object({ error: v.string(), ok: v.literal(false) })))
    .mutation(async ({ args, ctx }) => {
        const text = args.text.trim();

        if (text.length === 0) {
            return { error: "Say what the goal is.", ok: false as const };
        }

        const account = await loadTaskAccount(ctx, args.userId);

        if (account?.isAnonymous) {
            return { error: ANONYMOUS_GOALS_MESSAGE, ok: false as const };
        }

        const problem = taskAccessProblem(account);

        if (problem) {
            return { error: problem, ok: false as const };
        }

        const thread = await ctx.db.get(args.threadId);

        // A goal keeps a chat running on the owner's budget: only the owner starts one.
        if (!thread || thread.userId !== args.userId) {
            return { error: "A goal can only be set in your own chat.", ok: false as const };
        }

        // A goal replaces the thread's previous one here, with the insert: the later of two concurrent starts is the one left active.
        await endActiveGoals(ctx, args.threadId, "superseded");

        const { now } = ctx;
        const goalId = await ctx.db.insert("threadGoals", {
            config: args.config,
            costMicrodollars: 0,
            createdAt: now,
            maxCostMicrodollars: GOAL_MAX_COST_MICRODOLLARS,
            maxRounds: clampGoalRounds(args.maxRounds),
            ...(args.organizationId !== undefined && { organizationId: args.organizationId }),
            promptMessageId: args.promptMessageId,
            round: 0,
            startMessageId: args.promptMessageId,
            status: "active",
            text,
            threadId: args.threadId,
            updatedAt: now,
            userId: args.userId,
            verdicts: [],
        });

        return { goalId, ok: true as const };
    });

/**
 * The thread's goal, when one is still running. The run that just ended asks, to learn whether a review owes it a hand-off.
 * A run that knows its prompt row (`messageId`) is handed off only to the goal whose current round that row opened, so a
 * run of a superseded goal never reviews, or ends, the goal that replaced it.
 */
export const getActiveGoalForRun = internalQuery
    .input({
        messageId: v.optional(v.string().max(MAX_LENGTH.id)),
        streamId: v.optional(v.id("persistentStreams")),
        threadId: v.id("threads"),
    })
    .output(v.union(v.object({ goalId: v.id("threadGoals"), round: v.number() }), v.null()))
    .query(async ({ args, ctx }) => {
        // A continuation names its run by stream; `runPromptId` finds the prompt row the run answers.
        const messageId = await runPromptId(ctx, args);

        if (messageId === undefined) {
            return null;
        }

        const goals = await activeGoalsOf(ctx, args.threadId);
        const goal = goals.find((row) => row.promptMessageId === messageId);

        return goal ? { goalId: goal._id, round: goal.round } : null;
    });

/**
 * Whether the run that claimed `streamId` for the goal instruction row `messageId` is still wanted. The next round's
 * stream is written with the verdict and its job queued after; a new message, a regenerate, an edit or a Stop in
 * between ends the goal and leaves that stream `pending`. Such a run is refused here: its stream is closed and the
 * thread given back unless another run holds it.
 */
export const closeStaleGoalRound = internalMutation
    .input({ messageId: v.string().max(MAX_LENGTH.id), streamId: v.id("persistentStreams") })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const stream = await ctx.db.get(args.streamId);

        if (!stream) {
            return false;
        }

        const threadId = stream.threadId as Id<"threads">;

        const goals = await activeGoalsOf(ctx, threadId);

        if (goals.some((goal) => goal.promptMessageId === args.messageId)) {
            return true;
        }

        await ctx.db.patch(stream._id, { status: "done" });

        if (!(await hasLiveStream(ctx, threadId))) {
            await giveThreadBack(ctx, threadId);
        }

        return false;
    });

/**
 * Takes round `round`'s review, once. A redelivery, a stale job (the goal ended,
 * or the round was already reviewed) and a job for a round that is not next in
 * line all get `null` and do nothing.
 */
export const claimGoalRound = internalMutation
    .input({ goalId: v.id("threadGoals"), round: v.number() })
    .output(v.union(v.object({ text: v.string(), threadId: v.id("threads"), userId: v.string() }), v.null()))
    .mutation(async ({ args, ctx }) => {
        const goal = await ctx.db.get(args.goalId);

        if (!goal || goal.status !== "active" || goal.round !== args.round - 1 || (goal.claimedRound ?? 0) >= args.round) {
            return null;
        }

        await ctx.db.patch(goal._id, { claimedRound: args.round, updatedAt: ctx.now });

        return { text: goal.text, threadId: goal.threadId, userId: goal.userId };
    });

/**
 * What the reviewer reads of the round that just ended: the rows after the
 * round's prompt, as a bounded transcript, plus what those rows cost, the
 * turn of the last reply (where the verdict note sits), the round's last row
 * (to tell whether the displayed branch still ends there) and the untrusted
 * sources its tool results came from (`devices/lib/taint.ts`).
 */
export const roundTranscript = internalQuery
    .input({ goalId: v.id("threadGoals") })
    .output(
        v.object({
            costMicrodollars: v.number(),
            lastMessage: v.optional(v.object({ id: v.string(), order: v.number() })),
            lastOrder: v.optional(v.number()),
            taintedBy: v.optional(v.array(v.string())),
            transcript: v.string(),
        }),
    )
    .query(async ({ args, ctx }) => {
        const goal = await ctx.db.get(args.goalId);

        if (!goal) {
            return { costMicrodollars: 0, transcript: "" };
        }

        const recent = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", goal.threadId))
            .order("desc")
            .take(ROUND_ROWS_SCAN);
        const prompt = recent.findIndex((row) => row._id === goal.promptMessageId);
        // Newest first; the round is everything newer than its prompt (all of it, if the scan did not reach the prompt).
        const scanned = prompt === -1 ? recent : recent.slice(0, prompt);
        // Only the branch on display: a branch the user left must not reach the reviewer (or its taint, cost or last row).
        const thread = await ctx.db.get(goal.threadId);
        const onPath = thread?.activeLeafMessageId ? await candidatesOnActivePath(ctx, goal.threadId, thread.activeLeafMessageId, scanned) : undefined;
        const round = onPath ? scanned.filter((row) => onPath.has(row._id as string)) : scanned;
        const rows = round.toReversed().filter((row) => (row.message as { role?: string } | undefined)?.role !== "user");
        // The round's prompt row carries the taint of every round before it (the reviewer's note), which nothing in this round may drop.
        const taintRows = prompt === -1 ? round : recent.slice(0, prompt + 1);
        const last = round[0];
        const cost = sumMessageCosts(rows.map((row) => row.providerMetadata));
        const lastReply = rows.findLast((row) => !row.tool);

        return {
            costMicrodollars: Math.round(cost?.microdollars ?? 0),
            ...(last && { lastMessage: { id: last._id as string, order: last.order } }),
            ...(lastReply && { lastOrder: lastReply.order }),
            taintedBy: computeTaint(taintRows.toReversed().map((row) => row.message as { content?: unknown; role?: unknown })),
            transcript: buildGoalTranscript(rows),
        };
    });

const vNext = v.object({
    config: vGoalRunConfig,
    messageId: v.string(),
    organizationId: v.optional(v.string()),
    streamId: v.string(),
});

/**
 * Applies the reviewer's verdict on round `round`. Only the delivery that claimed
 * the round and finds the goal still active at that round gets past the first
 * check, so a redelivery records nothing, charges nothing and opens no stream.
 *
 * `costMicrodollars` is the round's run plus its review; a round the gateway did
 * not price adds nothing, which is why the round cap is the one that always bounds.
 */
export const recordGoalVerdict = internalMutation
    .input({
        anchorOrder: v.optional(v.number()),
        costMicrodollars: v.number(),
        goalId: v.id("threadGoals"),
        /** The round's last row: the goal goes on only while the thread's displayed branch still ends at or below it. */
        lastMessage: v.optional(v.object({ id: v.string().max(MAX_LENGTH.id), order: v.number() })),
        met: v.boolean(),
        reason: v.string().max(MAX_LENGTH.long),
        round: v.number(),
        /** Untrusted sources the round's tool results came from; carried onto the next round's instruction. */
        taintedBy: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
    })
    .output(v.object({ next: v.optional(vNext), outcome: v.union(v.literal("continue"), v.literal("ended"), v.literal("ignored")) }))
    .mutation(async ({ args, ctx }) => {
        const goal = await ctx.db.get(args.goalId);

        if (!goal || goal.status !== "active" || goal.claimedRound !== args.round || goal.round !== args.round - 1) {
            return { outcome: "ignored" as const };
        }

        const { now } = ctx;
        const costMicrodollars = goal.costMicrodollars + Math.max(0, Math.round(args.costMicrodollars));
        const reason = args.reason.trim();
        const progress = {
            costMicrodollars,
            round: args.round,
            updatedAt: now,
            verdicts: [
                ...goal.verdicts,
                { at: now, met: args.met, ...(args.anchorOrder !== undefined && { order: args.anchorOrder }), reason, round: args.round },
            ],
        };
        const decision = decideGoalRound({
            costMicrodollars,
            maxCostMicrodollars: goal.maxCostMicrodollars,
            maxRounds: goal.maxRounds,
            met: args.met,
            round: args.round,
        });

        // The run that just ended left the thread `running` for this hand-off; ending the goal gives it back.
        const end = async (status: "met" | "stopped", stopReason?: GoalStopReason) => {
            await ctx.db.patch(goal._id, withoutUndefined({ ...progress, endedAt: now, status, stopReason }));
            await giveThreadBack(ctx, goal.threadId);

            return { outcome: "ended" as const };
        };

        const thread = await ctx.db.get(goal.threadId);

        // Locking a chat stops its goal: no further round reads it, writes into it or sends it to the reviewer.
        if (thread && isThreadLocked(thread)) {
            return await end("stopped", "user");
        }

        // The user switched branch, or edited, while the review ran: the verdict is about a reply nobody is looking at, so it
        // neither counts as a win nor opens a round on a branch that is not shown.
        if (thread?.activeLeafMessageId) {
            // The round's prompt too: a branch the user switched to that never passes through it can hold no row of the round at
            // all, which leaves `lastMessage` unset.
            const prompt = await ctx.db.get(goal.promptMessageId as Id<"messages">);
            const candidates = [
                ...(prompt ? [{ _id: goal.promptMessageId, order: prompt.order }] : []),
                ...(args.lastMessage ? [{ _id: args.lastMessage.id, order: args.lastMessage.order }] : []),
            ];
            const onPath = await candidatesOnActivePath(ctx, goal.threadId, thread.activeLeafMessageId, candidates);

            if (candidates.some((candidate) => !onPath.has(candidate._id))) {
                return await end("stopped", "superseded");
            }
        }

        if (decision === "met") {
            return await end("met");
        }

        if (decision !== "continue") {
            return await end("stopped", decision);
        }

        // A chat in the trash is as good as gone: nothing is run into it.
        if (!thread || thread.deleted) {
            return await end("stopped", "error");
        }

        const account = await loadTaskAccount(ctx, goal.userId);

        if (taskAccessProblem(account) || !account || (await isAccountDeletionUnderway(ctx, goal.userId))) {
            return await end("stopped", "error");
        }

        if (!(await chargeRound(ctx, goal.userId, account))) {
            return await end("stopped", "daily_limit");
        }

        const saved = await addMessagesHandler(ctx, {
            agentName: GOAL_CONTINUATION_AGENT,
            // Not `fromUser`: nobody typed it, so it must not count as the user's reply to their chat.
            messages: [
                {
                    message: {
                        content: [{ text: buildGoalContinuationPrompt({ goal: goal.text, reason, taintedBy: args.taintedBy }), type: "text" }],
                        role: "user",
                    },
                    status: "success",
                },
            ],
            threadId: goal.threadId,
            userId: goal.userId,
        });
        const messageId = saved.messages[0]!._id as string;
        const { config } = goal;
        const streamId = await insertPersistentStream(ctx, {
            messageId,
            streamingConfig: {
                contentType: "text",
                ...(config.customSystemPrompt !== undefined && { customSystemPrompt: config.customSystemPrompt }),
                ...(config.enabledFeatures !== undefined && { enabledFeatures: config.enabledFeatures }),
                // The MCP servers the user picked for the goal, for every round, not only the first.
                ...(config.mcpServerNames !== undefined && { mcpServerNames: config.mcpServerNames }),
                model: config.model,
                ...(config.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
                ...(config.researchDepth !== undefined && { researchDepth: config.researchDepth }),
                ...(config.searchMode !== undefined && { searchMode: config.searchMode }),
                ...(config.statelessMode !== undefined && { statelessMode: config.statelessMode }),
            },
            threadId: goal.threadId,
            userId: goal.userId,
        });

        await patchThread(ctx.db, goal.threadId, { status: "running", updatedAt: now });
        await ctx.db.patch(goal._id, { ...progress, promptMessageId: messageId });

        return {
            next: { config, messageId, ...(goal.organizationId !== undefined && { organizationId: goal.organizationId }), streamId: streamId as string },
            outcome: "continue" as const,
        };
    });

/** The review itself failed (the reviewer is down): the goal ends, the thread is given back. */
export const failGoalReview = internalMutation
    .input({ goalId: v.id("threadGoals"), reason: vGoalStopReason, round: v.number() })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const goal = await ctx.db.get(args.goalId);

        if (!goal || goal.status !== "active" || goal.claimedRound !== args.round) {
            return false;
        }

        await stopGoalRow(ctx, goal, args.reason);
        await giveThreadBack(ctx, goal.threadId);

        return true;
    });

/** A goal untouched this long has lost its review job or its next round's queue message. */
export const GOAL_STALL_MS = 60 * 60 * 1000;

/**
 * Whether the goal is waiting on something that will still move it: a run queued or running (`pending` is
 * a round whose job has not started yet), or a tool approval nobody has answered. Only a goal with neither
 * has lost its hand-off.
 */
const isGoalWaiting = async (ctx: Pick<MutationCtx, "db">, goal: Doc<"threadGoals">): Promise<boolean> => {
    if (await hasLiveStream(ctx, goal.threadId)) {
        return true;
    }

    // The user's unanswered approvals are few; the thread's answered ones are not, and would hide a new pending one.
    const pending = await ctx.db
        .query("toolApprovalRuns")
        .withIndex("by_userId_status_createdAt", (q) => q.eq("userId", goal.userId).eq("status", "pending"))
        .take(100);

    return pending.some((approval) => approval.threadId === goal.threadId);
};

/**
 * Restarts the stall clock of the thread's active goal: a round that paused on an approval is waiting on a
 * person, not lost. Returns whether a goal was touched.
 */
export const touchGoal = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const goals = await activeGoalsOf(ctx, args.threadId);

        for (const goal of goals) {
            await ctx.db.patch(goal._id, { updatedAt: ctx.now });
        }

        return goals.length > 0;
    });

/**
 * Ends a goal whose round neither reviewed nor continued (an isolate evicted
 * mid-review, a queue send that failed) and gives its thread back. Housekeeping
 * calls it. Returns how many it ended. A goal that is still waiting is touched
 * instead, so the oldest rows of the batch are not the same waiting ones every
 * hour; a goal whose thread is gone is ended without the thread.
 */
export const reapStalledGoals = internalMutation
    .input({})
    .output(v.number())
    .mutation(async ({ ctx }) => {
        const stalled = await ctx.db
            .query("threadGoals")
            .withIndex("by_status_and_updatedAt", (q) => q.eq("status", "active").lt("updatedAt", ctx.now - GOAL_STALL_MS))
            .take(50);
        let ended = 0;

        for (const goal of stalled) {
            if (await isGoalWaiting(ctx, goal)) {
                await ctx.db.patch(goal._id, { updatedAt: ctx.now });
                continue;
            }

            await stopGoalRow(ctx, goal, "error");
            await giveThreadBack(ctx, goal.threadId);
            ended += 1;
        }

        return ended;
    });

/** Charges one more round to the user's daily limits, for a headless run that goes on toward a goal. `false` when they are spent. */
export const chargeGoalRound = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const account = await loadTaskAccount(ctx, args.userId);

        return !taskAccessProblem(account) && account !== null && (await chargeRound(ctx, args.userId, account));
    });
