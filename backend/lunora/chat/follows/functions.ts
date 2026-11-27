import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { internalMutation, internalQuery } from "../../_generated/server";
import { requireThreadPermission } from "../../agent/thread-read-access";
import { authMutation, authQuery, rateLimit } from "../../lib/crpc";
import { isUniqueViolation } from "../../lib/error-helpers";
import { LunoraError, v } from "lunorash/server";
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

/** Rows read per call of the export. */
const FOLLOW_BATCH = 100;

/**
 * Rows deleted per call of a bounded follow-row cleanup. Each delete is two D1 queries (the row's read, then the delete),
 * and a Workers Free invocation may run 50, so a call stays below that with the page read.
 */
const FOLLOW_DELETE_BATCH = 20;

/** Rounds a follow write goes again when a concurrent write changed the row between its read and its write. */
const FOLLOW_WRITE_ATTEMPTS = 5;

/**
 * The `updatedAt` of a row a refused accept is taking back ({@link withdrawThreadFollowDefault}): stamped by a
 * conditional write before the delete, so a write that reads it treats the row as gone and never lands on it.
 */
const WITHDRAWN = -1;

/** The stamp a write leaves: past the row's, so every write changes it and a conditional write on the old one misses. */
const nextStamp = (now: number, previous: number): number => Math.max(now, previous + 1);

/**
 * Writes a person's follow state, creating the row when there is none. Each write is conditional on the stamp it read
 * and leaves a later one, so a refused accept's take-back ({@link withdrawThreadFollowDefault}) never erases it. Two
 * first writes that race cannot both insert: `by_user_and_thread` is unique, so the one that loses reads again and
 * writes over the other's row.
 */
export const setThreadFollowState = async (
    ctx: Pick<MutationCtx, "db">,
    { now, state, threadId, userId }: { now: number; state: ThreadFollowState; threadId: Id<"threads">; userId: string },
): Promise<void> => {
    for (let attempt = 0; attempt < FOLLOW_WRITE_ATTEMPTS; attempt += 1) {
        const existing = await ctx.db.threadFollows.findFirst({ consistency: "primary", where: { threadId, userId } });

        if (existing && existing.updatedAt !== WITHDRAWN) {
            const { applied } = await ctx.db.patchIf("threadFollows", existing._id, {
                patch: { state, updatedAt: nextStamp(now, existing.updatedAt) },
                where: { updatedAt: existing.updatedAt },
            });

            if (applied) {
                return;
            }

            continue;
        }

        // A row a refused accept is taking back: deleted here too (deleting it twice is harmless), and this choice
        // written as a new row, which that take-back, keyed on the old row's id, does not touch.
        if (existing) {
            await ctx.db.delete("threadFollows", existing._id);
        }

        try {
            await ctx.db.insert("threadFollows", { createdAt: now, state, threadId, updatedAt: now, userId });

            return;
        } catch (error) {
            // Another write for this person and thread inserted between the read and the insert: read it again.
            if (!isUniqueViolation(error)) {
                throw error;
            }
        }
    }

    throw new LunoraError("CONFLICT", "The follow setting changed at the same moment. Try again.");
};

/** The follow row a default wrote, as it wrote it: what {@link withdrawThreadFollowDefault} takes back. */
export interface WrittenThreadFollow {
    id: Id<"threadFollows">;
    state: ThreadFollowState;
    updatedAt: number;
}

/**
 * Writes a default state only when the person has no row yet, so an explicit choice is never overwritten. The row it
 * wrote, `null` when one stood already: a caller that is refused afterwards takes back only a row it wrote, unchanged.
 */
export const ensureThreadFollowDefault = async (
    ctx: Pick<MutationCtx, "db">,
    { now, state, threadId, userId }: { now: number; state: ThreadFollowState; threadId: Id<"threads">; userId: string },
): Promise<WrittenThreadFollow | null> => {
    const existing = await ctx.db.threadFollows.findFirst({ consistency: "primary", where: { threadId, userId } });

    if (existing) {
        return null;
    }

    try {
        const id = (await ctx.db.insert("threadFollows", { createdAt: now, state, threadId, updatedAt: now, userId })) as Id<"threadFollows">;

        return { id, state, updatedAt: now };
    } catch (error) {
        // Another write inserted the person's row between the read and the insert: that row stands.
        if (!isUniqueViolation(error)) {
            throw error;
        }

        return null;
    }
};

/**
 * Takes back the default a refused accept wrote, only while the row is still that default: the stamp is a conditional
 * write on the state and stamp written (one statement, decided with the write), so a choice the person made since,
 * which always leaves a later stamp, is kept. Once stamped, a follow write treats the row as gone
 * ({@link setThreadFollowState}), so none lands between the stamp and the delete. `true` when it removed the row.
 */
export const withdrawThreadFollowDefault = async (ctx: Pick<MutationCtx, "db">, written: WrittenThreadFollow): Promise<boolean> => {
    const { applied } = await ctx.db.patchIf("threadFollows", written.id, {
        patch: { state: "off", updatedAt: WITHDRAWN },
        where: { state: written.state, updatedAt: written.updatedAt },
    });

    if (!applied) {
        return false;
    }

    await ctx.db.delete("threadFollows", written.id);

    return true;
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
    const page = await ctx.db.threadFollows.findMany({ consistency: "primary", limit: FOLLOW_DELETE_BATCH, where: { threadId } });

    await Promise.all(page.page.map((row) => ctx.db.delete("threadFollows", row._id)));

    return page.isDone;
};

/** Deletes one batch of a person's follow rows; `true` when none are left. Account erasure drains it round by round. */
export const deleteFollowRowsOfUserBatch = async (ctx: Pick<MutationCtx, "db">, userId: string): Promise<boolean> => {
    const page = await ctx.db.threadFollows.findMany({ consistency: "primary", limit: FOLLOW_DELETE_BATCH, where: { userId } });

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
