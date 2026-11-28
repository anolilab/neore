/**
 * Builds `groupChatSkills` for the group chats an owner had before the index existed, then marks the owner's index complete
 * (`groupChatSkillIndex.completedAt`), which is what lets readers use it instead of their bounded scan.
 *
 * Run by the shard housekeeping sweep ({@link sweepGroupSkillIndex}), so it reaches every shard active in the last 30 days;
 * a shard idle longer keeps the scan until its owner is back. It is not a `defineMigration`: a migration rewrites rows of its own
 * table and cannot fill another one.
 *
 * One page of threads per step, read through `by_userId`, whose key no thread edit changes (a thread archived or moved
 * mid-walk keeps its place, so none is skipped). A step names the cursor it was scheduled for and does nothing if the row has
 * moved on, so two chains (a sweep while one is running) cannot both advance. Each thread is reconciled, not appended, so a
 * thread the triggers already indexed, or edited mid-walk, comes out right.
 */
import { v } from "lunorash/server";

import { internal } from "../../_generated/internal";
import type { MutationCtx } from "../../_generated/server";
import { internalMutation } from "../../_generated/server";
import { isAccountDeletionUnderway } from "../../gdpr/deletion-guard";
import { currentUserShard } from "../../lib/shard-context";
import { mutationStore, reconcileThreadIndex } from "./skill-index";

/** Threads one step indexes. */
export const THREADS_PER_STEP = 50;

const step = async (ctx: MutationCtx, userId: string, cursor: string | null): Promise<void> => {
    const state = await ctx.db.groupChatSkillIndex.findFirst({ where: { userId } });

    if (state?.completedAt !== undefined || (state?.cursor ?? null) !== cursor) {
        return;
    }

    const { continueCursor, isDone, page } = await ctx.db
        .query("threads")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .paginate({ cursor, numItems: THREADS_PER_STEP });
    const store = mutationStore(ctx);

    for (const thread of page) {
        await reconcileThreadIndex(store, thread._id as string, thread);
    }

    const next = isDone ? { completedAt: ctx.now, cursor: "" } : { cursor: continueCursor };

    if (state) {
        await ctx.db.patch("groupChatSkillIndex", state._id, next);
    } else {
        await ctx.db.insert("groupChatSkillIndex", { userId, ...next });
    }

    if (!isDone) {
        await ctx.scheduler.runAfter(0, internal.chat.group.skill_index_backfill.runGroupSkillIndexStep, { cursor: continueCursor });
    }
};

/**
 * Housekeeping sweep (`shardSweeps()`): starts the walk for an owner whose index is not complete, or restarts one whose chain died
 * (a step scheduled and lost). Stands down while the account is being deleted: a row written behind the erasure would stay.
 */
export const sweepGroupSkillIndex = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const userId = currentUserShard();

        if (userId === undefined || (await isAccountDeletionUnderway(ctx, userId))) {
            return null;
        }

        const state = await ctx.db.groupChatSkillIndex.findFirst({ where: { userId } });

        if (state?.completedAt === undefined) {
            await step(ctx, userId, state?.cursor ?? null);
        }

        return null;
    });

/** One step of the walk, scheduled by the one before it. */
export const runGroupSkillIndexStep = internalMutation
    .input({ cursor: v.union(v.string(), v.null()) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const userId = currentUserShard();

        if (userId !== undefined && !(await isAccountDeletionUnderway(ctx, userId))) {
            await step(ctx, userId, args.cursor);
        }

        return null;
    });
