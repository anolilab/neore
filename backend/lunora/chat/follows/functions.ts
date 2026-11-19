import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { internalMutation, internalQuery } from "../../_generated/server";
import { requireThreadPermission } from "../../agent/thread-read-access";
import { authMutation, authQuery, rateLimit } from "../../lib/crpc";
import { isUniqueViolation } from "../../lib/error-helpers";
import { v } from "lunorash/server";
import { MAX_LENGTH } from "../../lib/validators";

/**
 * Whether a person follows a thread for new-reply notifications. The state is
 * per person and thread; no row means "off". Share and accept write the rows
 * (`chat/sharing.ts`), and removing a person from a thread deletes theirs.
 *
 * `threadFollows` is `.global()` like `threadAccess`: a follow row is read by the
 * follower, written by the thread's owner (on their menu), and erased with the
 * follower's account or the thread, so no one shard holds every row it needs.
 */

/** A follow state set by the person: follow, unfollow, or mute. */
export type ThreadFollowState = "on" | "off" | "muted";

/** The size a row read costs the request's read budget. */
const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Rows read or deleted per call of a bounded follow-row cleanup. */
const FOLLOW_BATCH = 100;

/**
 * Writes a person's follow state, creating the row when there is none. Two first writes that race cannot both insert:
 * `by_user_and_thread` is unique, so the one that loses patches the row the other wrote.
 */
export const setThreadFollowState = async (
    ctx: Pick<MutationCtx, "db">,
    { now, state, threadId, userId }: { now: number; state: ThreadFollowState; threadId: Id<"threads">; userId: string },
): Promise<void> => {
    const existing = await ctx.db.threadFollows.findFirst({ consistency: "primary", where: { threadId, userId } });

    if (existing) {
        await ctx.db.patch("threadFollows", existing._id, { state, updatedAt: now });

        return;
    }

    try {
        await ctx.db.insert("threadFollows", { createdAt: now, state, threadId, updatedAt: now, userId });
    } catch (error) {
        if (!isUniqueViolation(error)) {
            throw error;
        }

        // Another write for this person and thread inserted between the read and the insert: this choice is the later one.
        const raced = await ctx.db.threadFollows.findFirst({ consistency: "primary", where: { threadId, userId } });

        if (!raced) {
            throw error;
        }

        await ctx.db.patch("threadFollows", raced._id, { state, updatedAt: now });
    }
};

/** Writes a default state only when the person has no row yet, so an explicit choice is never overwritten. */
export const ensureThreadFollowDefault = async (
    ctx: Pick<MutationCtx, "db">,
    { now, state, threadId, userId }: { now: number; state: ThreadFollowState; threadId: Id<"threads">; userId: string },
): Promise<void> => {
    const existing = await ctx.db.threadFollows.findFirst({ consistency: "primary", where: { threadId, userId } });

    if (existing) {
        return;
    }

    try {
        await ctx.db.insert("threadFollows", { createdAt: now, state, threadId, updatedAt: now, userId });
    } catch (error) {
        // Another write inserted the person's row between the read and the insert: that row stands.
        if (!isUniqueViolation(error)) {
            throw error;
        }
    }
};

/** Deletes a person's follow row for a thread, if any: used when they leave the thread or the thread goes. */
export const deleteThreadFollowRow = async (ctx: Pick<MutationCtx, "db">, { threadId, userId }: { threadId: Id<"threads">; userId: string }): Promise<void> => {
    const existing = await ctx.db.threadFollows.findFirst({ consistency: "primary", where: { threadId, userId } });

    if (existing) {
        await ctx.db.delete("threadFollows", existing._id);
    }
};

/** Deletes one batch of a thread's follow rows; `true` when none are left, so the caller can delete the thread. */
export const deleteFollowRowsOfThread = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">): Promise<boolean> => {
    const page = await ctx.db.threadFollows.findMany({ consistency: "primary", limit: FOLLOW_BATCH, where: { threadId } });

    await Promise.all(page.page.map((row) => ctx.db.delete("threadFollows", row._id)));

    return page.isDone;
};

/** Deletes one batch of a person's follow rows; `true` when none are left. Account erasure drains it round by round. */
export const deleteFollowRowsOfUserBatch = async (ctx: Pick<MutationCtx, "db">, userId: string): Promise<boolean> => {
    const page = await ctx.db.threadFollows.findMany({ consistency: "primary", limit: FOLLOW_BATCH, where: { userId } });

    await Promise.all(page.page.map((row) => ctx.db.delete("threadFollows", row._id)));

    return page.isDone;
};

/** Removes a member's follow row when the owner or an admin removes their access: a trusted write, past the admin's RLS view. */
export const deleteFollowRowOfRemovedMember = internalMutation
    .input({ threadId: v.id("threads"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args: { threadId, userId }, ctx: context }) => {
        await deleteThreadFollowRow(context, { threadId, userId });

        return null;
    });

/** A person's follow rows, one batch per call, for the account export. */
export const collectThreadFollowsForExport = internalQuery
    .input({
        cursor: v.optional(v.string().max(MAX_LENGTH.cursor)),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(
        v.object({
            continueCursor: v.optional(v.string()),
            follows: v.array(
                v.object({
                    createdAt: v.number(),
                    state: v.union(v.literal("on"), v.literal("off"), v.literal("muted")),
                    threadId: v.string(),
                    updatedAt: v.number(),
                }),
            ),
            // The whole rows read, not what is exported: the action's read budget counts what was read.
            readBytes: v.number(),
        }),
    )
    .query(async ({ args: { cursor, userId }, ctx: context }) => {
        const page = await context.db.threadFollows.findMany({ consistency: "primary", cursor, limit: FOLLOW_BATCH, where: { userId } });

        return {
            continueCursor: page.isDone ? undefined : (page.continueCursor ?? undefined),
            follows: page.page.map((row) => {
                return { createdAt: row.createdAt, state: row.state, threadId: row.threadId as string, updatedAt: row.updatedAt };
            }),
            readBytes: page.page.reduce((total, row) => total + bytesOf(row), 0),
        };
    });

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

        // From the primary: the menu refetches right after a change, and a replica can still hold the old choice.
        const row = await context.db.threadFollows.findFirst({ consistency: "primary", where: { threadId, userId } });

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

        // The grant is read from the primary: a member removed a moment ago must not write a row back.
        await requireThreadPermission(context, threadId, userId, "read", unlockProof, { primary: true });
        await setThreadFollowState(context, { now: context.now, state, threadId, userId });

        context.log.event("chat.set_thread_follow", { state });
    });
