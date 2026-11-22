/**
 * What the thread view reads of a goal (`useThreadGoal`): the goal text, its
 * status, the reviewer's verdict per round and the message that started it. Starting a goal rides on
 * `/chat/start`; stopping one is the thread's ordinary stop.
 *
 * The chat's pinned goal is stored on the thread (`getPinnedGoal`, `setPinnedGoal`, `clearPinnedGoal`). The web app
 * sends it with each message that carries no goal of its own; the backend has no pin of its own to apply.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import { setThreadPinnedGoal } from "../../agent/table-writes";
import { requireOwnedThread } from "../../agent/thread-read-access";
import { authMutation, authQuery, rateLimit } from "../../lib/crpc";
import { isThreadLocked } from "../../lib/thread-lock";
import { MAX_LENGTH } from "../../lib/validators";
import { threadGateOutcome } from "../lib/thread-gate";
import { GOAL_MAX_ROUNDS, GOAL_TEXT_MAX } from "./shared";
import { vGoalStatus, vGoalStopReason, vGoalVerdict, vPinnedGoal } from "./validators";

export const getThreadGoal = authQuery
    .input({
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(
        v.union(
            v.object({
                costMicrodollars: v.number(),
                createdAt: v.number(),
                goalId: v.string(),
                maxCostMicrodollars: v.number(),
                maxRounds: v.number(),
                round: v.number(),
                startMessageId: v.string(),
                status: vGoalStatus,
                stopReason: v.optional(vGoalStopReason),
                text: v.string(),
                verdicts: v.array(vGoalVerdict),
            }),
            v.null(),
        ),
    )
    .query(async ({ args: { threadId, unlockProof }, ctx: context }) => {
        const { userId } = context.user;
        const thread = await context.db.get("threads", threadId as Id<"threads">);

        // A goal belongs to its chat: with the chat gone nothing of it is shown.
        if (!thread || thread.deleted) {
            return null;
        }

        // A goal quotes the chat's work: a locked chat's goal needs its proof.
        if (isThreadLocked(thread) && (await threadGateOutcome(context, { level: "read", threadId, unlockProof, userId })) !== "ok") {
            return null;
        }

        const goal = await context.db
            .query("threadGoals")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId as Id<"threads">))
            .order("desc")
            .first();

        if (!goal || goal.userId !== userId) {
            return null;
        }

        return {
            costMicrodollars: goal.costMicrodollars,
            createdAt: goal.createdAt,
            goalId: goal._id,
            maxCostMicrodollars: goal.maxCostMicrodollars,
            maxRounds: goal.maxRounds,
            round: goal.round,
            startMessageId: goal.startMessageId,
            status: goal.status,
            ...(goal.stopReason !== undefined && { stopReason: goal.stopReason }),
            text: goal.text,
            verdicts: goal.verdicts,
        };
    });

/** The chat's pinned goal, or `null`. A locked chat's pin needs its proof, as its goal does. */
export const getPinnedGoal = authQuery
    .input({
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.union(vPinnedGoal, v.null()))
    .query(async ({ args: { threadId, unlockProof }, ctx: context }) => {
        const { userId } = context.user;
        const thread = await context.db.get("threads", threadId as Id<"threads">);

        if (!thread || thread.deleted || thread.userId !== userId) {
            return null;
        }

        if (isThreadLocked(thread) && (await threadGateOutcome(context, { level: "read", threadId, unlockProof, userId })) !== "ok") {
            return null;
        }

        return thread.pinnedGoal ?? null;
    });

/**
 * Pins `text` as the chat's goal, replacing any pin. Owner only, and a locked chat needs its unlock proof, as its content
 * does. Refused while impersonating: a goal spends the owner's budget over several rounds, and an admin acting as the owner
 * must not start one.
 */
export const setPinnedGoal = authMutation
    .input({
        maxRounds: v.number(),
        text: v.string().max(GOAL_TEXT_MAX),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .use(rateLimit("chat/update"))
    .output(v.null())
    .mutation(async ({ args: { maxRounds, text, threadId, unlockProof }, ctx: context }) => {
        if (context.user.impersonatedBy) {
            throw new LunoraError("FORBIDDEN", "A pinned goal cannot be set while impersonating");
        }

        const trimmed = text.trim();

        if (trimmed.length === 0) {
            throw new LunoraError("BAD_REQUEST", "A goal needs text");
        }

        if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > GOAL_MAX_ROUNDS) {
            throw new LunoraError("BAD_REQUEST", `Review rounds must be between 1 and ${GOAL_MAX_ROUNDS}`);
        }

        await requireOwnedThread(context, threadId, context.user.userId, unlockProof);
        await setThreadPinnedGoal(context.db, threadId, { maxRounds, text: trimmed });

        return null;
    });

/** Removes the chat's pinned goal. Owner only; a locked chat needs its unlock proof. */
export const clearPinnedGoal = authMutation
    .input({ threadId: v.id("threads"), unlockProof: v.optional(v.string().max(MAX_LENGTH.short)) })
    .use(rateLimit("chat/update"))
    .output(v.null())
    .mutation(async ({ args: { threadId, unlockProof }, ctx: context }) => {
        // Set and clear refuse alike: an impersonating admin does not change the owner's pin.
        if (context.user.impersonatedBy) {
            throw new LunoraError("FORBIDDEN", "A pinned goal cannot be cleared while impersonating");
        }

        await requireOwnedThread(context, threadId, context.user.userId, unlockProof);
        await setThreadPinnedGoal(context.db, threadId, undefined);

        return null;
    });
