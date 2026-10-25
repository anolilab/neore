/**
 * The notification inbox: the bell's live query, read state, and the writer
 * entry point for actions. Writers in a mutation call `notify()` directly
 * (`notify.ts`); retention is {@link pruneOldNotifications}, a per-shard sweep.
 */
import { v } from "lunorash/server";

import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { notify } from "./notify";
import { linksToLockedThread, redactForLockedThread } from "./locked-link";
import { notificationInputFields, vNotificationView } from "./validators";

/** Rows the bell lists: the newest, read or not. */
export const INBOX_LIMIT = 30;
/** The unread badge counts up to this and then reads "99+". */
export const UNREAD_COUNT_CAP = 100;
/** Notifications older than this are deleted by the housekeeping sweep. */
export const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Rows one "mark all read" or one prune call touches; the rest wait for the next. */
const WRITE_BATCH = 200;

export const toNotificationView = (row: Doc<"notifications">) => {
    return {
        _id: row._id as string,
        createdAt: row.createdAt,
        read: row.readAt !== undefined,
        title: row.title,
        type: row.type,
        ...(row.body !== undefined && { body: row.body }),
        ...(row.link !== undefined && { link: row.link }),
        ...(row.outcome !== undefined && { outcome: row.outcome }),
    };
};

/**
 * What any surface shows of notification rows (the inbox, the home page): a row
 * linked to a locked chat is redacted, whichever writer or write date. Rows
 * written before a lock still carry the title, so this runs at read time too.
 */
export const toRedactedNotificationViews = async (db: Parameters<typeof linksToLockedThread>[0], rows: Doc<"notifications">[]) =>
    await Promise.all(
        rows.map(async (row) => {
            const view = toNotificationView(row);

            return (await linksToLockedThread(db, row.link)) ? redactForLockedThread(view) : view;
        }),
    );

/** Unread rows of `userId`, newest first, at most `limit`. */
export const loadUnread = async (ctx: Pick<QueryCtx, "db">, userId: string, limit: number) => {
    const unread = await ctx.db.notifications.findMany({
        limit,
        orderBy: [{ createdAt: "desc" }],
        where: { readAt: { isNull: true }, userId },
    });

    return unread.page;
};

/**
 * The bell: newest notifications plus the unread count, in ONE query so the
 * bell costs one live subscription. Both reads are bounded.
 */
export const getNotificationInbox = authQuery
    .input({})
    .output(v.object({ items: v.array(vNotificationView), unreadCount: v.number() }))
    .query(async ({ ctx }) => {
        const { userId } = ctx.user;
        const [recent, unread] = await Promise.all([
            ctx.db.notifications.findMany({ limit: INBOX_LIMIT, orderBy: [{ createdAt: "desc" }], where: { userId } }),
            loadUnread(ctx, userId, UNREAD_COUNT_CAP),
        ]);

        return { items: await toRedactedNotificationViews(ctx.db, recent.page), unreadCount: unread.length };
    });

export const markNotificationRead = authMutation
    .use(rateLimit("notifications/update"))
    .input({ notificationId: v.id("notifications") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const row = await ctx.db.get(args.notificationId);

        if (row?.userId === ctx.user.userId && row.readAt === undefined) {
            await ctx.db.patch(row._id, { readAt: ctx.now });
        }

        ctx.log.event("notifications.mark_notification_read", { marked: row?.userId === ctx.user.userId });

        return null;
    });

/** Marks up to one batch read; returns whether unread rows remain (the client just calls again). */
export const markAllNotificationsRead = authMutation
    .use(rateLimit("notifications/update"))
    .input({})
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ ctx }) => {
        const { now } = ctx;
        const unread = await loadUnread(ctx, ctx.user.userId, WRITE_BATCH + 1);

        await Promise.all(unread.slice(0, WRITE_BATCH).map(async (row) => await ctx.db.patch(row._id, { readAt: now })));

        ctx.log.event("notifications.mark_all_notifications_read", { batchSize: Math.min(unread.length, WRITE_BATCH) });

        return { hasMore: unread.length > WRITE_BATCH };
    });

/** The writer for actions (and for `notify()` handing a write to the recipient's shard). */
export const createNotification = internalMutation
    .input(notificationInputFields)
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await notify(ctx, args);

        return null;
    });

/**
 * {@link createNotification} for several rows in ONE transaction, so a caller with a batch
 * (the gateway's rule alerts) pays one shard round trip instead of one per row. Each row is
 * still idempotent on its `dedupeKey`; a throw rolls the whole batch back, and a redelivery
 * writes it again.
 */
export const createNotifications = internalMutation
    .input({ notifications: v.array(v.object({ ...notificationInputFields })) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        for (const notification of args.notifications) {
            await notify(ctx, notification);
        }

        return null;
    });

/**
 * Retention: deletes this shard's notifications older than
 * {@link NOTIFICATION_RETENTION_MS}. Runs from the housekeeping fan-out
 * (`lib/shard-housekeeping.ts`), which the one-minute cron tick drives, so no
 * cron of its own. One batch per sweep; a backlog drains over successive sweeps.
 */
export const pruneOldNotifications = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const cutoff = ctx.now - NOTIFICATION_RETENTION_MS;
        const { page: expired } = await ctx.db.notifications.findMany({
            limit: WRITE_BATCH,
            orderBy: [{ createdAt: "asc" }],
            where: { createdAt: { lt: cutoff } },
        });

        await Promise.all(expired.map(async (row) => await ctx.db.delete(row._id)));

        return null;
    });
