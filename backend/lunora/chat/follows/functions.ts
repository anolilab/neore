import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { requireThreadPermission } from "../../agent/thread-read-access";
import { authMutation, authQuery, rateLimit } from "../../lib/crpc";
import { v } from "lunorash/server";
import { MAX_LENGTH } from "../../lib/validators";

/**
 * Whether a person follows a thread for new-reply notifications. The state is
 * per person and thread; no row means "off". Share and accept write the rows
 * (`chat/sharing.ts`), and removing a person from a thread deletes theirs.
 */

/** A follow state set by the person: follow, unfollow, or mute. */
export type ThreadFollowState = "on" | "off" | "muted";

/** Writes a person's follow state, creating the row when there is none. */
export const setThreadFollowState = async (
    ctx: Pick<MutationCtx, "db">,
    { now, state, threadId, userId }: { now: number; state: ThreadFollowState; threadId: Id<"threads">; userId: string },
): Promise<void> => {
    const [existing] = await ctx.db
        .query("threadFollows")
        .withIndex("by_user_and_thread", (q) => q.eq("userId", userId).eq("threadId", threadId))
        .take(1);

    if (existing) {
        await ctx.db.patch("threadFollows", existing._id, { state, updatedAt: now });

        return;
    }

    await ctx.db.insert("threadFollows", { createdAt: now, state, threadId, updatedAt: now, userId });
};

/** Writes a default state only when the person has no row yet, so an explicit choice is never overwritten. */
export const ensureThreadFollowDefault = async (
    ctx: Pick<MutationCtx, "db">,
    { now, state, threadId, userId }: { now: number; state: ThreadFollowState; threadId: Id<"threads">; userId: string },
): Promise<void> => {
    const [existing] = await ctx.db
        .query("threadFollows")
        .withIndex("by_user_and_thread", (q) => q.eq("userId", userId).eq("threadId", threadId))
        .take(1);

    if (!existing) {
        await ctx.db.insert("threadFollows", { createdAt: now, state, threadId, updatedAt: now, userId });
    }
};

/** Deletes a person's follow row for a thread, if any: used when they leave the thread or the thread goes. */
export const deleteThreadFollowRow = async (ctx: Pick<MutationCtx, "db">, { threadId, userId }: { threadId: Id<"threads">; userId: string }): Promise<void> => {
    const rows = await ctx.db
        .query("threadFollows")
        .withIndex("by_user_and_thread", (q) => q.eq("userId", userId).eq("threadId", threadId))
        .take(5);

    await Promise.all(rows.map((row) => ctx.db.delete("threadFollows", row._id)));
};

export const getThreadFollow = authQuery
    .input({
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(
        v.object({
            state: v.union(v.literal("on"), v.literal("off"), v.literal("muted")),
        }),
    )
    .query(async ({ args: { threadId, unlockProof }, ctx: context }) => {
        const { userId } = context.user;

        // Only someone who can read the thread may see or change its follow state.
        await requireThreadPermission(context, threadId, userId, "read", unlockProof);

        const [row] = await context.db
            .query("threadFollows")
            .withIndex("by_user_and_thread", (q) => q.eq("userId", userId).eq("threadId", threadId))
            .take(1);

        return { state: row?.state ?? "off" };
    });

export const setThreadFollow = authMutation
    .use(rateLimit("follows/update"))
    .input({
        state: v.union(v.literal("on"), v.literal("off"), v.literal("muted")),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .mutation(async ({ args: { state, threadId, unlockProof }, ctx: context }) => {
        const { userId } = context.user;

        await requireThreadPermission(context, threadId, userId, "read", unlockProof);
        await setThreadFollowState(context, { now: context.now, state, threadId, userId });

        context.log.event("chat.set_thread_follow", { state });
    });
