/**
 * Redacts a collaborator's notifications for a chat the owner has just locked.
 *
 * A notification lives on its RECIPIENT's shard and the chat on the OWNER's, so
 * the recipient's read cannot see the lock (`linksToLockedThread` counts an
 * unreadable chat as open). Grants and locks exclude each other: a lock is refused
 * while a grant exists and a grant is refused on a locked chat. So the users who
 * had access are the ones whose invite was accepted — `threadInvites` rows outlive
 * a revoked grant, which is what makes a former collaborator findable.
 *
 * `enableThreadLock` schedules one job per such user onto that user's own shard.
 * The job rewrites that user's rows for the chat. Rows written after the lock are
 * redacted by `notify()` on the owner's shard, before the hand-off.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { patchRow } from "../lib/patch";
import { LOCKED_THREAD_TITLE } from "../lib/thread-lock";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { threadIdOfLink } from "./locked-link";

/** Notification rows one job rewrites. A user with more continues in the next job. */
export const REDACT_BATCH = 200;
/** Invites read per lock. ponytail: a chat with more than this many invites keeps the rest's titles; add a page loop when one has. */
const INVITE_LIMIT = 100;
/**
 * The fan-out waits this long, so a notification scheduled before the lock lands
 * first. A grace period, not a guarantee: a write delivered later keeps its title.
 */
const FANOUT_DELAY_MS = 30_000;

/** The users who accepted an invite to `threadId`, other than its owner. A revoked grant still counts: the invite keeps `acceptedBy`. */
export const granteesOf = (invites: ReadonlyArray<{ acceptedBy?: string }>, ownerId: string): string[] => [
    ...new Set(invites.flatMap((invite) => (invite.acceptedBy && invite.acceptedBy !== ownerId ? [invite.acceptedBy] : []))),
];

/** Schedules one redaction job per former or current collaborator, each on that user's shard. Call from the owner's lock mutation. */
export const scheduleGranteeRedaction = async (ctx: Pick<MutationCtx, "db" | "scheduler">, threadId: Id<"threads">, ownerId: string): Promise<void> => {
    const { page } = await ctx.db.threadInvites.findMany({ limit: INVITE_LIMIT, where: { threadId } });

    for (const userId of granteesOf(page, ownerId)) {
        await runAfterOnShard(ctx.scheduler, FANOUT_DELAY_MS, internal.notifications.locked_redact.redactLockedLinks, { threadId, userId }, userId);
    }
};

/** Already redacted: rewriting it again would change nothing, so the write is skipped. */
const isRedacted = (row: { body?: string; title: string }): boolean => row.title === LOCKED_THREAD_TITLE && row.body === undefined;

/** Pending or failed outbox mail still carries the subject; sent mail cannot be unsent. */
const redactPendingMail = async (ctx: MutationCtx, notificationId: Id<"notifications">): Promise<void> => {
    const { page } = await ctx.db.outcomeEmails.findMany({ limit: 5, where: { notificationId } });

    for (const mail of page) {
        if (mail.status !== "sent" && mail.title !== LOCKED_THREAD_TITLE) {
            await ctx.db.patch(mail._id, { title: LOCKED_THREAD_TITLE });
        }
    }
};

/**
 * Runs on the recipient's shard. Rewrites this user's notifications that link to
 * `threadId`, one page of `REDACT_BATCH` rows at a time, and re-schedules itself
 * with the cursor while rows remain. Re-running it is harmless.
 */
export const redactLockedLinks = internalMutation
    .input({
        cursor: v.optional(v.string()),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const page = await ctx.db
            .query("notifications")
            .withIndex("by_userId_createdAt", (q) => q.eq("userId", args.userId))
            .paginate({ cursor: args.cursor ?? null, numItems: REDACT_BATCH });

        for (const row of page.page) {
            if (threadIdOfLink(row.link) !== String(args.threadId) || isRedacted(row)) {
                continue;
            }

            // Same shape as `redactForLockedThread`: `undefined` removes the body.
            await patchRow(ctx.db, row, { body: undefined, title: LOCKED_THREAD_TITLE });
            await redactPendingMail(ctx, row._id);
        }

        if (!page.isDone) {
            await runAfterOnShard(
                ctx.scheduler,
                0,
                internal.notifications.locked_redact.redactLockedLinks,
                { cursor: page.continueCursor, threadId: args.threadId, userId: args.userId },
                args.userId,
            );
        }

        return null;
    });
