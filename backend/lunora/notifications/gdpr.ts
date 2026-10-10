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

import { internalMutation, internalQuery } from "../_generated/server";
import { MAX_PUSH_SUBSCRIPTIONS_PER_USER } from "./push";

const BATCH = 200;

/** Every notification is at most 30 days old (`pruneOldNotifications`); this bounds the read anyway. */
const EXPORT_NOTIFICATIONS_MAX = 5000;

export const collectNotificationsForExport = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ notifications: v.array(v.any()), pushSubscriptions: v.array(v.any()) }))
    .query(async ({ args: { userId }, ctx }) => {
        const [notifications, devices] = await Promise.all([
            ctx.db.notifications.findMany({ limit: EXPORT_NOTIFICATIONS_MAX, orderBy: [{ createdAt: "desc" }], where: { userId } }),
            ctx.push.list({ limit: MAX_PUSH_SUBSCRIPTIONS_PER_USER, userId }),
        ]);

        return {
            notifications: notifications.page.map(({ _id, body, createdAt, link, outcome, readAt, title, type }) => {
                return { _id, body, createdAt, link, outcome, readAt, title, type };
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
        const [notifications, devices, briefState] = await Promise.all([
            ctx.db.notifications.findMany({ limit: BATCH, where: { userId } }),
            ctx.push.list({ limit: BATCH, userId }),
            ctx.db.dailyBriefState.findMany({ limit: BATCH, where: { userId } }),
        ]);
        const rows = [...notifications.page, ...briefState.page];

        await Promise.all([
            ...rows.map(async (row) => await ctx.db.delete(row._id)),
            ...devices.map(async (device) => await ctx.push.unregister(device.id, { userId })),
        ]);

        return { hasMore: [notifications.page, devices, briefState.page].some((page) => page.length >= BATCH) };
    });
