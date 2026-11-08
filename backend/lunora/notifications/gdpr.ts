/**
 * Notifications, push subscriptions and daily-brief state in the GDPR export
 * and account deletion. Wired into `gdpr/workflows/export-workflow.ts`
 * ("collect-notifications") and `gdpr/workflows/deletion-workflow.ts`
 * ("delete-user-notifications"). Deletion follows the residual steps' contract
 * (`gdpr/steps/residual-deletion-steps.ts`): at most `BATCH` rows per table per
 * call, `{ hasMore }` back, idempotent on retry. Push subscriptions are not on
 * the user's shard but in `@lunora/notify`'s D1 store, reached via `ctx.push`.
 */
import { v } from "lunorash/server";

import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { deleteIfUnchanged, MAX_PUSH_DEVICES_PER_USER } from "./push-device-writes";
import { MAX_PUSH_SUBSCRIPTIONS_PER_USER } from "./push";

const BATCH = 200;

/** Every notification is at most 30 days old (`pruneOldNotifications`); this bounds the read anyway. */
const EXPORT_NOTIFICATIONS_MAX = 5000;

/**
 * Every phone row of the user, page by page to the last one: the cap keeps it to a handful, but an export never drops
 * a row on the assumption that it does.
 */
const allPushDevices = async (ctx: QueryCtx, userId: string) => {
    const rows: Doc<"pushDevices">[] = [];
    let cursor: string | undefined;

    do {
        const { continueCursor, isDone, page } = await ctx.db.pushDevices.findMany({
            consistency: "primary",
            cursor,
            limit: MAX_PUSH_DEVICES_PER_USER,
            where: { userId },
        });

        rows.push(...page);
        cursor = isDone ? undefined : (continueCursor ?? undefined);
    } while (cursor !== undefined);

    return rows;
};

export const collectNotificationsForExport = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ notifications: v.array(v.any()), outcomeEmails: v.array(v.any()), pushDevices: v.array(v.any()), pushSubscriptions: v.array(v.any()) }))
    .query(async ({ args: { userId }, ctx }) => {
        const [notifications, outbox, devices, phones] = await Promise.all([
            ctx.db.notifications.findMany({ limit: EXPORT_NOTIFICATIONS_MAX, orderBy: [{ createdAt: "desc" }], where: { userId } }),
            // Queued and sent task-outcome emails hold the user's title and link; deletion removes them, so export does too.
            ctx.db.outcomeEmails.findMany({ limit: EXPORT_NOTIFICATIONS_MAX, orderBy: [{ createdAt: "desc" }], where: { userId } }),
            ctx.push.list({ limit: MAX_PUSH_SUBSCRIPTIONS_PER_USER, userId }),
            allPushDevices(ctx, userId),
        ]);

        return {
            notifications: notifications.page.map(({ _id, body, createdAt, link, outcome, readAt, title, type }) => {
                return { _id, body, createdAt, link, outcome, readAt, title, type };
            }),
            outcomeEmails: outbox.page.map(({ _id, attempts, createdAt, link, sentAt, status, title }) => {
                return { _id, attempts, createdAt, link, sentAt, status, title };
            }),
            // The phone's platform and when it registered; the token, like a browser's keys, is a delivery credential.
            pushDevices: phones.map(({ createdAt, lastSeenAt, platform }) => {
                return { createdAt, platform, updatedAt: lastSeenAt };
            }),
            // The browser and when it subscribed; the endpoint and keys are
            // credentials for delivering to that browser, not data about the user.
            pushSubscriptions: devices.map(({ createdAt, lastSeenAt, metadata }) => {
                return { createdAt, updatedAt: lastSeenAt, userAgent: metadata?.userAgent };
            }),
        };
    });

export const deleteUserNotifications = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const [notifications, devices, briefState, outbox, phones] = await Promise.all([
            ctx.db.notifications.findMany({ limit: BATCH, where: { userId } }),
            ctx.push.list({ limit: BATCH, userId }),
            ctx.db.dailyBriefState.findMany({ limit: BATCH, where: { userId } }),
            ctx.db.outcomeEmails.findMany({ limit: BATCH, where: { userId } }),
            ctx.db.pushDevices.findMany({ consistency: "primary", limit: BATCH, where: { userId } }),
        ]);

        let phonesLeft = 0;

        await Promise.all([
            // A phone another account took over since the read above is that account's now: it stays.
            ...phones.page.map(async (row) => {
                phonesLeft += (await deleteIfUnchanged(ctx.db, row)) ? 0 : 1;
            }),
            ...notifications.page.map(async (row) => await ctx.db.delete("notifications", row._id)),
            ...briefState.page.map(async (row) => await ctx.db.delete("dailyBriefState", row._id)),
            ...outbox.page.map(async (row) => await ctx.db.delete("outcomeEmails", row._id)),
            ...devices.map(async (device) => await ctx.push.unregister(device.id, { userId })),
        ]);

        // A phone skipped above (it registered again meanwhile) is still the account's: come back for it.
        return {
            hasMore: phonesLeft > 0 || [notifications.page, devices, briefState.page, outbox.page, phones.page].some((page) => page.length >= BATCH),
        };
    });
