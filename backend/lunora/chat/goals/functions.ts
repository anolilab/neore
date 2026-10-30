/**
 * What the thread view reads of a goal (`useThreadGoal`): the goal text, its
 * status, the reviewer's verdict per round and the message that started it. Starting a goal rides on
 * `/chat/start`; stopping one is the thread's ordinary stop.
 */
import { v } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import { authQuery } from "../../lib/crpc";
import { isThreadLocked } from "../../lib/thread-lock";
import { MAX_LENGTH } from "../../lib/validators";
import { threadGateOutcome } from "../lib/thread-gate";
import { vGoalStatus, vGoalStopReason, vGoalVerdict } from "./validators";

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
        const thread = await context.db.get(threadId as Id<"threads">);

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
